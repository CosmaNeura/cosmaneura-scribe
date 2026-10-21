/* Actual broker logic with real CF/XPC values and the requirement parser.
 * Only public kernel/Security/reply boundaries are synthetic. No process,
 * monitor, connection, service or application is activated. */
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <assert.h>
#include <fcntl.h>
#include <libproc.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/event.h>
#include <unistd.h>
#include <xpc/xpc.h>
#ifdef NDEBUG
#error assertions_must_remain_enabled
#endif
static int registration_count = 1, drain_result;
static bool bad_receipt, changed_parent, changed_bridge;
static unsigned registrations, drains, guest_calls, validity_calls, static_calls, information_calls;
static OSStatus guest_result, validity_result, static_result, information_result;
static CFTypeRef sandbox;
static bool missing_information, malformed_information, malformed_claims;
static SecCodeRef captured_code;
static pid_t fixture_getpid(void) { return 4243; }
static pid_t fixture_getppid(void) { return 4242; }
static int fixture_kqueue(void) { return 333; }
static int fixture_fcntl(int fd, int command, ...) { assert(fd == 333 && command == F_SETFD); return 0; }
static int fixture_close(int fd) { assert(fd == 333); return 0; }
static int fixture_process(int pid, int flavor, uint64_t argument, void *buffer, int size) {
    assert((pid == 4242 || pid == 4243) && flavor == PROC_PIDTBSDINFO && argument == 0
        && size == (int)sizeof(struct proc_bsdinfo));
    struct proc_bsdinfo info = {0}; info.pbi_uid = getuid();
    info.pbi_ppid = pid == 4243 ? 4242 : 4000;
    info.pbi_start_tvsec = pid; info.pbi_start_tvusec = 123;
    if ((pid == 4242 && changed_parent) || (pid == 4243 && changed_bridge)) info.pbi_start_tvusec++;
    memcpy(buffer, &info, sizeof(info)); return size;
}
static int fixture_kevent(int fd, const struct kevent *changes, int count,
    struct kevent *events, int available, const struct timespec *timeout) {
    assert(fd == 333 && available == 1 && timeout && timeout->tv_sec == 0 && timeout->tv_nsec == 0);
    if (changes) {
        registrations++;
        assert(count == 1 && changes->ident == 4242 && changes->filter == EVFILT_PROC
            && changes->flags == (EV_ADD | EV_ENABLE | EV_CLEAR | EV_RECEIPT)
            && changes->fflags == (NOTE_EXEC | NOTE_EXIT));
        *events = *changes; events->flags = EV_ERROR; events->data = bad_receipt ? EPERM : 0;
        return registration_count;
    }
    assert(count == 0); drains++;
    memset(events, 0, sizeof(*events)); events->ident = 4242; events->filter = EVFILT_PROC; events->fflags = NOTE_EXEC;
    return drain_result;
}
static OSStatus fixture_guest(SecCodeRef host, CFDictionaryRef attrs, SecCSFlags flags, SecCodeRef *result) {
    assert(!host && flags == 0 && registrations == 1);
    CFNumberRef number = CFDictionaryGetValue(attrs, kSecGuestAttributePid); int pid = 0;
    assert(number && CFNumberGetValue(number, kCFNumberIntType, &pid) && pid == 4242);
    guest_calls++; *result = guest_result ? NULL : (SecCodeRef)CFRetain(CFSTR("original-parent-code"));
    captured_code = *result; return guest_result;
}
static OSStatus fixture_validity(SecCodeRef code, SecCSFlags flags, SecRequirementRef requirement) {
    assert(code == captured_code && flags == 0 && requirement); validity_calls++; return validity_result;
}
static OSStatus fixture_static(SecCodeRef code, SecCSFlags flags, SecStaticCodeRef *result) {
    assert(code == captured_code && flags == 0); static_calls++;
    *result = static_result ? NULL : (SecStaticCodeRef)CFRetain(CFSTR("original-static-code")); return static_result;
}
static OSStatus fixture_information(SecStaticCodeRef code, SecCSFlags flags, CFDictionaryRef *result) {
    assert(code && flags == kSecCSSigningInformation); information_calls++; *result = NULL;
    if (information_result || missing_information) return information_result;
    if (malformed_information) { *result = (CFDictionaryRef)CFRetain(CFSTR("malformed")); return 0; }
    CFMutableDictionaryRef claims = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    if (sandbox) CFDictionarySetValue(claims, CFSTR("com.apple.security.app-sandbox"), sandbox);
    CFTypeRef value = malformed_claims ? (CFTypeRef)CFSTR("malformed") : (CFTypeRef)claims;
    const void *key = kSecCodeInfoEntitlementsDict;
    *result = CFDictionaryCreate(NULL, &key, &value, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFRelease(claims); return 0;
}
static xpc_object_t fixture_reply(xpc_object_t request) { assert(request); return xpc_dictionary_create_empty(); }
#define getpid fixture_getpid
#define getppid fixture_getppid
#define kqueue fixture_kqueue
#define fcntl fixture_fcntl
#define close fixture_close
#define kevent(...) fixture_kevent(__VA_ARGS__)
#define proc_pidinfo fixture_process
#define SecCodeCopyGuestWithAttributes fixture_guest
#define SecCodeCheckValidity fixture_validity
#define SecCodeCopyStaticCode fixture_static
#define SecCodeCopySigningInformation fixture_information
#define xpc_dictionary_create_reply fixture_reply
#include "StoreParentBroker.c"
#undef xpc_dictionary_create_reply
#undef SecCodeCopySigningInformation
#undef SecCodeCopyStaticCode
#undef SecCodeCheckValidity
#undef SecCodeCopyGuestWithAttributes
#undef proc_pidinfo
#undef kevent
#undef close
#undef fcntl
#undef kqueue
#undef getppid
#undef getpid
static void reset(void) {
    registration_count = 1; drain_result = 0; bad_receipt = changed_parent = changed_bridge = false;
    registrations = drains = guest_calls = validity_calls = static_calls = information_calls = 0;
    guest_result = validity_result = static_result = information_result = 0;
    sandbox = kCFBooleanTrue; missing_information = malformed_information = malformed_claims = false;
}
static struct scribe_store_parent_broker *prepare(void) {
    return scribe_store_parent_prepare(4242, "JVV65668U6.com.cosmaneura.scribe.beta.desktop.store", "--provider-v1");
}
static xpc_object_t request(uint64_t sequence) {
    xpc_object_t value = xpc_dictionary_create_empty();
    xpc_dictionary_set_string(value, "type", "parent-proof"); xpc_dictionary_set_uint64(value, "version", 1);
    xpc_dictionary_set_uint64(value, "sequence", sequence); xpc_dictionary_set_string(value, "mode", "--provider-v1");
    return value;
}
int main(void) {
    unsigned checks = 0; reset();
    struct scribe_store_parent_broker *broker = prepare(); assert(broker && guest_calls == 1); checks++;
    assert(scribe_store_parent_is_current(broker) && guest_calls == 1 && validity_calls == 2); checks++;
    drain_result = 1; assert(!scribe_store_parent_is_current(broker)); checks++;
    unsigned calls = validity_calls; drain_result = 0;
    assert(!scribe_store_parent_is_current(broker) && validity_calls == calls); checks++;
    scribe_store_parent_discard(broker);
    for (int failure = 0; failure < 3; failure++) {
        reset(); if (failure == 0) registration_count = -1; if (failure == 1) registration_count = 0; if (failure == 2) bad_receipt = true;
        assert(!prepare() && guest_calls == 0); checks++;
    }
    reset(); drain_result = -1; assert(!prepare() && guest_calls == 0); checks++;
    int one = 1; CFNumberRef number = CFNumberCreate(NULL, kCFNumberIntType, &one);
    CFTypeRef claims[] = {kCFBooleanTrue, kCFBooleanFalse, NULL, CFSTR("true"), number};
    for (size_t index = 0; index < sizeof(claims)/sizeof(claims[0]); index++) {
        reset(); sandbox = claims[index]; broker = prepare(); assert((broker != NULL) == (index == 0)); checks++;
        scribe_store_parent_discard(broker);
    }
    CFRelease(number);
    for (int failure = 0; failure < 7; failure++) {
        reset();
        if (failure == 0) guest_result = errSecParam;
        if (failure == 1) validity_result = errSecParam;
        if (failure == 2) static_result = errSecParam;
        if (failure == 3) information_result = errSecParam;
        if (failure == 4) missing_information = true;
        if (failure == 5) malformed_information = true;
        if (failure == 6) malformed_claims = true;
        assert(!prepare()); checks++;
        if (failure == 0) { assert(!validity_calls && !static_calls && !information_calls); checks++; }
        if (failure == 1) { assert(!static_calls && !information_calls); checks++; }
    }
    for (int changed = 0; changed < 2; changed++) {
        reset(); broker = prepare(); assert(broker); calls = validity_calls;
        if (changed) changed_bridge = true; else changed_parent = true;
        assert(!scribe_store_parent_is_current(broker) && validity_calls == calls); checks++;
        changed_bridge = changed_parent = false;
        assert(!scribe_store_parent_is_current(broker)); checks++; scribe_store_parent_discard(broker);
    }
    const char *keys[] = {"type", "version", "sequence", "mode"};
    for (size_t index = 0; index < 4; index++) {
        reset(); broker = prepare(); xpc_object_t value = request(1);
        xpc_dictionary_set_value(value, keys[index], NULL); xpc_dictionary_set_bool(value, "unexpected", true);
        assert(xpc_dictionary_get_count(value) == 4 && !scribe_store_parent_reply(broker, value)); checks++;
        assert(!scribe_store_parent_is_current(broker)); checks++; xpc_release(value); scribe_store_parent_discard(broker);
    }
    reset(); broker = prepare(); xpc_object_t value = request(1); xpc_object_t reply = scribe_store_parent_reply(broker, value);
    assert(reply && xpc_dictionary_get_count(reply) == 6 && xpc_dictionary_get_int64(reply, "host") == 4242
        && xpc_dictionary_get_uint64(reply, "sequence") == 1 && xpc_dictionary_get_bool(reply, "valid")); checks++;
    xpc_release(reply);
    assert(!scribe_store_parent_reply(broker, value) && !scribe_store_parent_is_current(broker)); checks++;
    xpc_release(value); scribe_store_parent_discard(broker);
    printf("store_parent_broker_checks_%u_passed\n", checks); return 0;
}
