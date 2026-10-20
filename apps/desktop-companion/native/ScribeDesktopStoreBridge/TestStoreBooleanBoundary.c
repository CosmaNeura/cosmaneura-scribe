/* Compile this fixture once with SCRIBE_TEST_BRIDGE=1 and once with =0.
 * Actual production guards consume real CoreFoundation values. Only public
 * SecCode identity/validity/signing-info boundaries supply synthetic objects;
 * the Service variant supplies a fixed4243-to4242 public process-info result.
 * The real requirement parser is retained. No production main, XPC connection,
 * kernel PID lookup, app, service, trust or credential path is exercised. */
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <libproc.h>
#include <xpc/xpc.h>

#ifndef SCRIBE_TEST_BRIDGE
#error SCRIBE_TEST_BRIDGE_must_select_one_production_boundary
#endif
#ifdef NDEBUG
#error assertions_must_remain_enabled
#endif

static CFTypeRef sandbox_value, inherit_value;
static OSStatus guest_result, message_result, static_result, info_result, validity_result;
static bool malformed_claims, missing_claims, malformed_information, missing_information;
static unsigned message_calls, validity_calls, static_calls, information_calls;
#if !SCRIBE_TEST_BRIDGE
static unsigned last_failure, last_failure_class;
#endif

static OSStatus fixture_guest(SecCodeRef host, CFDictionaryRef attributes, SecCSFlags flags, SecCodeRef *code) {
    assert(host == NULL && flags == 0);
    CFTypeRef selector = CFDictionaryGetValue(attributes, kSecGuestAttributePid);
    int pid = 0;
    assert(selector && CFGetTypeID(selector) == CFNumberGetTypeID());
    assert(CFNumberGetValue((CFNumberRef)selector, kCFNumberIntType, &pid) && pid == 4242);
    *code = guest_result == errSecSuccess ? (SecCodeRef)CFRetain(CFSTR("synthetic-code")) : NULL;
    return guest_result;
}
static OSStatus fixture_message(xpc_object_t message, SecCSFlags flags, SecCodeRef *code) {
    assert(message && xpc_get_type(message) == XPC_TYPE_DICTIONARY && flags == 0);
    message_calls++;
    /* Payload values deliberately do not select the signed entitlement result. */
    *code = message_result == errSecSuccess ? (SecCodeRef)CFRetain(CFSTR("synthetic-code")) : NULL;
    return message_result;
}
static OSStatus fixture_static(SecCodeRef code, SecCSFlags flags, SecStaticCodeRef *result) {
    assert(code && flags == 0);
    static_calls++;
    *result = static_result == errSecSuccess ? (SecStaticCodeRef)CFRetain(CFSTR("synthetic-static")) : NULL;
    return static_result;
}
static OSStatus fixture_validity(SecCodeRef code, SecCSFlags flags, SecRequirementRef requirement) {
    assert(code && flags == 0);
    validity_calls++;
    /* Parent requirements are actually compiled; an authenticated XPC sender
     * first validates dynamically with the documented optional NULL requirement. */
    (void)requirement;
    return validity_result;
}
static OSStatus fixture_information(SecStaticCodeRef code, SecCSFlags flags, CFDictionaryRef *information) {
    assert(code && flags == kSecCSSigningInformation);
    information_calls++;
    *information = NULL;
    if (info_result != errSecSuccess) return info_result;
    if (missing_information) return errSecSuccess;
    if (malformed_information) {
        *information = (CFDictionaryRef)CFRetain(CFSTR("not-information"));
        return errSecSuccess;
    }
    CFMutableDictionaryRef claims = CFDictionaryCreateMutable(NULL, 0,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    if (sandbox_value) CFDictionarySetValue(claims, CFSTR("com.apple.security.app-sandbox"), sandbox_value);
    if (inherit_value) CFDictionarySetValue(claims, CFSTR("com.apple.security.inherit"), inherit_value);
    const void *keys[] = {kSecCodeInfoEntitlementsDict};
    const void *values[] = {malformed_claims ? (CFTypeRef)CFSTR("not-a-dictionary") : (CFTypeRef)claims};
    *information = CFDictionaryCreate(NULL, keys, values, missing_claims ? 0 : 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFRelease(claims);
    return errSecSuccess;
}
#if !SCRIBE_TEST_BRIDGE
static pid_t fixture_peer_pid(xpc_connection_t peer) {
    assert(peer); return 4243;
}
static int fixture_process_info(int pid, int flavor, uint64_t argument, void *buffer, int size) {
    assert(pid == 4243 && flavor == PROC_PIDTBSDINFO && argument == 0
        && size == (int)sizeof(struct proc_bsdinfo));
    struct proc_bsdinfo process = {0};
    process.pbi_ppid = 4242; process.pbi_uid = getuid();
    process.pbi_start_tvsec = 1000; process.pbi_start_tvusec = 123;
    memcpy(buffer, &process, sizeof(process)); return (int)sizeof(process);
}
#endif

#define SecCodeCopyGuestWithAttributes fixture_guest
#define SecCodeCreateWithXPCMessage fixture_message
#define SecCodeCopyStaticCode fixture_static
#define SecCodeCheckValidity fixture_validity
#define SecCodeCopySigningInformation fixture_information
#if SCRIBE_TEST_BRIDGE
#define main unused_production_bridge_main
#include "StorePipeBridge.c"
#undef main
#else
#define xpc_connection_get_pid fixture_peer_pid
#define proc_pidinfo fixture_process_info
#include "../ScribeDesktopAudio/Sources/ScribeStorePipe/StorePipeService.c"
#undef proc_pidinfo
#undef xpc_connection_get_pid
#endif
#undef SecCodeCopyGuestWithAttributes
#undef SecCodeCreateWithXPCMessage
#undef SecCodeCopyStaticCode
#undef SecCodeCheckValidity
#undef SecCodeCopySigningInformation

static bool sender_guard(xpc_object_t message) {
#if SCRIBE_TEST_BRIDGE
    return reply_sandbox_is_true(message);
#else
    return peer_booleans_are_true(message, &last_failure, &last_failure_class);
#endif
}

int main(void) {
    int zero = 0, one = 1;
    CFNumberRef number_zero = CFNumberCreate(NULL, kCFNumberIntType, &zero);
    CFNumberRef number_one = CFNumberCreate(NULL, kCFNumberIntType, &one);
    CFArrayRef array = CFArrayCreate(NULL, NULL, 0, &kCFTypeArrayCallBacks);
    CFDictionaryRef dictionary = CFDictionaryCreate(NULL, NULL, NULL, 0,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFTypeRef candidates[] = {kCFBooleanTrue, kCFBooleanFalse, NULL, CFSTR("true"),
        number_one, number_zero, array, dictionary};
    unsigned checks = 0;
    xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
    /* Forged response/request fields cannot substitute for signed claims. */
    xpc_dictionary_set_bool(message, "com.apple.security.app-sandbox", true);
    xpc_dictionary_set_bool(message, "com.apple.security.inherit", true);
    for (size_t index = 0; index < sizeof(candidates) / sizeof(candidates[0]); index++) {
        bool expected = index == 0;
        sandbox_value = candidates[index]; inherit_value = kCFBooleanTrue;
        assert(store_boolean_is_true(sandbox_value) == expected); checks++;
        assert(sender_guard(message) == expected); checks++;
#if SCRIBE_TEST_BRIDGE
        assert(parent_is_store_host(4242, "JVV65668U6.com.cosmaneura.scribe.beta.desktop.store") == expected); checks++;
#else
        assert(verified_host((xpc_connection_t)message, 4242) == expected); checks++;
        if (!expected) {
            assert(last_failure == (index == 1 ? 21 : index == 2 ? 19 : 20)); checks++;
        } else {
            assert(last_failure == 0); checks++;
        }
        assert(last_failure_class == 0); checks++;
        sandbox_value = kCFBooleanTrue; inherit_value = candidates[index];
        assert(sender_guard(message) == expected); checks++;
        assert(last_failure == (expected ? 0 : index == 1 ? 24 : index == 2 ? 22 : 23)); checks++;
        assert(last_failure_class == 0); checks++;
#endif
    }
    sandbox_value = inherit_value = kCFBooleanTrue;
    xpc_dictionary_set_bool(message, "com.apple.security.app-sandbox", false);
    xpc_dictionary_set_bool(message, "com.apple.security.inherit", false);
    assert(sender_guard(message)); checks++; /* Signed true, payload false. */
    malformed_claims = true; assert(!sender_guard(message)); checks++; malformed_claims = false;
    info_result = errSecParam; assert(!sender_guard(message)); checks++; info_result = errSecSuccess;
    static_result = errSecParam; assert(!sender_guard(message)); checks++; static_result = errSecSuccess;
    message_result = errSecParam; assert(!sender_guard(message)); checks++; message_result = errSecSuccess;
    validity_result = errSecParam;
    unsigned static_before = static_calls, information_before = information_calls;
    assert(!sender_guard(message)); checks++;
    assert(static_calls == static_before && information_calls == information_before); checks++;
    validity_result = errSecSuccess;
#if SCRIBE_TEST_BRIDGE
    guest_result = errSecParam;
    assert(!parent_is_store_host(4242, "JVV65668U6.com.cosmaneura.scribe.beta.desktop.store")); checks++;
    guest_result = errSecSuccess; validity_result = errSecParam;
    assert(!parent_is_store_host(4242, "JVV65668U6.com.cosmaneura.scribe.beta.desktop.store")); checks++;
    validity_result = errSecSuccess; static_result = errSecParam;
    assert(!parent_is_store_host(4242, "JVV65668U6.com.cosmaneura.scribe.beta.desktop.store")); checks++;
    static_result = errSecSuccess; info_result = errSecParam;
    assert(!parent_is_store_host(4242, "JVV65668U6.com.cosmaneura.scribe.beta.desktop.store")); checks++;
#else
    /* Classify the first failing seam without changing admission or running
     * any later Security call. Request payload bits remain non-authoritative. */
    sandbox_value = inherit_value = kCFBooleanTrue;
    malformed_information = true;
    assert(!sender_guard(message) && last_failure == 17 && last_failure_class == 0); checks++;
    malformed_information = false; missing_information = true;
    assert(!sender_guard(message) && last_failure == 17 && last_failure_class == 0); checks++;
    missing_information = false; missing_claims = true;
    assert(!sender_guard(message) && last_failure == 18 && last_failure_class == 0); checks++;
    missing_claims = false; malformed_claims = true;
    assert(!sender_guard(message) && last_failure == 18 && last_failure_class == 0); checks++;
    malformed_claims = false; info_result = errSecParam;
    assert(!sender_guard(message) && last_failure == 16 && last_failure_class == 27); checks++;
    info_result = errSecSuccess; static_result = errSecParam;
    information_before = information_calls;
    assert(!sender_guard(message) && last_failure == 15 && last_failure_class == 27); checks++;
    assert(information_calls == information_before); checks++;
    static_result = errSecSuccess; validity_result = errSecParam;
    static_before = static_calls; information_before = information_calls;
    assert(!sender_guard(message) && last_failure == 14 && last_failure_class == 27); checks++;
    assert(static_calls == static_before && information_calls == information_before); checks++;
    validity_result = errSecSuccess; message_result = errSecParam;
    unsigned validity_before = validity_calls;
    static_before = static_calls; information_before = information_calls;
    assert(!sender_guard(message) && last_failure == 13 && last_failure_class == 27); checks++;
    assert(validity_calls == validity_before && static_calls == static_before
        && information_calls == information_before); checks++;
    message_result = errSecSuccess;
    information_before = information_calls;
    unsigned message_before = message_calls;
    assert(sender_guard(message) && last_failure == 0 && last_failure_class == 0); checks++;
    assert(message_calls == message_before + 1 && information_calls == information_before + 2); checks++;
    sandbox_value = inherit_value = kCFBooleanFalse;
    information_before = information_calls;
    assert(!sender_guard(message) && last_failure == 21 && last_failure_class == 0); checks++;
    assert(information_calls == information_before + 1); checks++;
    sandbox_value = inherit_value = kCFBooleanTrue;
    const OSStatus status_classes[] = {errSecCSSignatureNotVerifiable, errSecCSUnsigned,
        errSecCSInvalidObjectRef, errSecCSStaticCodeChanged, errSecCSReqFailed,
        errSecCSBadResource, errSecCSNoSuchCode, (OSStatus)12345};
    for (size_t index = 0; index < sizeof(status_classes) / sizeof(status_classes[0]); index++) {
        message_result = status_classes[index]; validity_before = validity_calls;
        static_before = static_calls; information_before = information_calls;
        assert(!sender_guard(message) && last_failure == 13 && last_failure_class == 25 + index); checks++;
        assert(validity_calls == validity_before && static_calls == static_before
            && information_calls == information_before); checks++;
    }
    message_result = errSecSuccess;
    assert(sender_guard(message) && last_failure == 0 && last_failure_class == 0); checks++;
    guest_result = errSecParam;
    assert(!verified_host((xpc_connection_t)message, 4242)); checks++;
    guest_result = errSecSuccess; validity_result = errSecParam;
    static_before = static_calls; information_before = information_calls;
    assert(!verified_host((xpc_connection_t)message, 4242)); checks++;
    assert(static_calls == static_before && information_calls == information_before); checks++;
    validity_result = errSecSuccess; static_result = errSecParam;
    assert(!verified_host((xpc_connection_t)message, 4242)); checks++;
    static_result = errSecSuccess; info_result = errSecParam;
    assert(!verified_host((xpc_connection_t)message, 4242)); checks++;
    info_result = errSecSuccess; malformed_claims = true;
    assert(!verified_host((xpc_connection_t)message, 4242)); checks++;
#endif
    xpc_release(message); CFRelease(dictionary); CFRelease(array);
    CFRelease(number_one); CFRelease(number_zero);
    printf("store_boolean_production_boundary_%s_checks_%u_passed\n",
        SCRIBE_TEST_BRIDGE ? "bridge" : "service", checks);
    return 0;
}
