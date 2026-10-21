#include "StoreParentBroker.h"
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <fcntl.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <unistd.h>

struct scribe_store_parent_broker {
    pid_t parent, bridge;
    struct proc_bsdinfo parent_generation, bridge_generation;
    SecCodeRef code;
    SecRequirementRef requirement;
    int monitor;
    bool invalid, watching;
    char *mode;
    uint64_t sequence;
};
static bool store_boolean_is_true(CFTypeRef value) {
    return value && CFGetTypeID(value) == CFBooleanGetTypeID() && CFBooleanGetValue((CFBooleanRef)value);
}
static bool code_boolean_is_true(SecStaticCodeRef code, CFStringRef key) {
    CFDictionaryRef information = NULL;
    bool valid = code && SecCodeCopySigningInformation(code, kSecCSSigningInformation, &information) == errSecSuccess
        && information && CFGetTypeID(information) == CFDictionaryGetTypeID();
    CFTypeRef claims = valid ? CFDictionaryGetValue(information, kSecCodeInfoEntitlementsDict) : NULL;
    valid = claims && CFGetTypeID(claims) == CFDictionaryGetTypeID()
        && store_boolean_is_true(CFDictionaryGetValue((CFDictionaryRef)claims, key));
    if (information) CFRelease(information);
    return valid;
}
static bool same_generation(pid_t pid, const struct proc_bsdinfo *original) {
    struct proc_bsdinfo current = {0};
    return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &current, sizeof(current)) == sizeof(current)
        && current.pbi_uid == getuid() && current.pbi_uid == original->pbi_uid
        && current.pbi_ppid == original->pbi_ppid
        && current.pbi_start_tvsec == original->pbi_start_tvsec
        && current.pbi_start_tvusec == original->pbi_start_tvusec;
}
/* Called on one broker queue. Nothing blocks waiting for a kernel event. Any
 * pending event or malformed/read-error result permanently revokes the proof. */
static bool drain_monitor(struct scribe_store_parent_broker *broker) {
    if (broker->invalid) return false;
    struct kevent event = {0}; const struct timespec now = {0};
    int count = kevent(broker->monitor, NULL, 0, &event, 1, &now);
    if (count != 0) broker->invalid = true;
    return !broker->invalid;
}
bool scribe_store_parent_is_current(struct scribe_store_parent_broker *broker) {
    if (!broker || !drain_monitor(broker)) return false;
    SecStaticCodeRef static_code = NULL;
    bool valid = getpid() == broker->bridge && getppid() == broker->parent
        && same_generation(broker->bridge, &broker->bridge_generation)
        && same_generation(broker->parent, &broker->parent_generation)
        && SecCodeCheckValidity(broker->code, 0, broker->requirement) == errSecSuccess
        && SecCodeCopyStaticCode(broker->code, 0, &static_code) == errSecSuccess
        && code_boolean_is_true(static_code, CFSTR("com.apple.security.app-sandbox"))
        && drain_monitor(broker)
        && getppid() == broker->parent
        && same_generation(broker->bridge, &broker->bridge_generation)
        && same_generation(broker->parent, &broker->parent_generation);
    if (static_code) CFRelease(static_code);
    if (!valid) broker->invalid = true;
    return valid;
}
void scribe_store_parent_discard(struct scribe_store_parent_broker *broker) {
    if (!broker || broker->watching) return;
    if (broker->code) CFRelease(broker->code);
    if (broker->requirement) CFRelease(broker->requirement);
    if (broker->monitor >= 0) close(broker->monitor);
    free(broker->mode); free(broker);
}
struct scribe_store_parent_broker *scribe_store_parent_prepare(pid_t parent, const char *group, const char *mode) {
    if (parent <= 1 || parent != getppid() || !group || !mode) return NULL;
    struct scribe_store_parent_broker *broker = calloc(1, sizeof(*broker));
    if (!broker) return NULL;
    broker->monitor = -1; broker->parent = parent; broker->bridge = getpid(); broker->mode = strdup(mode);
    bool valid = broker->mode
        && proc_pidinfo(parent, PROC_PIDTBSDINFO, 0, &broker->parent_generation, sizeof(broker->parent_generation)) == sizeof(broker->parent_generation)
        && proc_pidinfo(broker->bridge, PROC_PIDTBSDINFO, 0, &broker->bridge_generation, sizeof(broker->bridge_generation)) == sizeof(broker->bridge_generation)
        && broker->parent_generation.pbi_uid == getuid()
        && broker->bridge_generation.pbi_uid == getuid()
        && broker->bridge_generation.pbi_ppid == (uint32_t)parent;
    if (!valid) { scribe_store_parent_discard(broker); return NULL; }
    broker->monitor = kqueue();
    if (broker->monitor < 0 || fcntl(broker->monitor, F_SETFD, FD_CLOEXEC) != 0) {
        scribe_store_parent_discard(broker); return NULL;
    }
    struct kevent change, receipt = {0}; const struct timespec now = {0};
    EV_SET(&change, (uintptr_t)parent, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_CLEAR | EV_RECEIPT,
        NOTE_EXEC | NOTE_EXIT, 0, NULL);
    valid = kevent(broker->monitor, &change, 1, &receipt, 1, &now) == 1
        && receipt.ident == (uintptr_t)parent && receipt.filter == EVFILT_PROC
        && (receipt.flags & EV_ERROR) && receipt.data == 0 && drain_monitor(broker);
    /* Keep these exact objects for every later proof. A fresh PID lookup could
     * otherwise admit a different same-identifier executable after exec. */
    CFNumberRef pid = valid ? CFNumberCreate(NULL, kCFNumberIntType, &parent) : NULL;
    const void *keys[] = {kSecGuestAttributePid}, *values[] = {pid};
    CFDictionaryRef attributes = pid ? CFDictionaryCreate(NULL, keys, values, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks) : NULL;
    char text[768];
    int length = snprintf(text, sizeof(text), "anchor apple generic and identifier \"com.cosmaneura.scribe.beta.desktop.store\" and certificate leaf[subject.OU] = \"JVV65668U6\" and entitlement[\"com.apple.security.app-sandbox\"] exists and entitlement[\"com.apple.security.application-groups\"] = \"%s\"", group);
    CFStringRef expression = length > 0 && (size_t)length < sizeof(text) ? CFStringCreateWithCString(NULL, text, kCFStringEncodingUTF8) : NULL;
    valid = attributes && expression && SecRequirementCreateWithString(expression, 0, &broker->requirement) == errSecSuccess
        && SecCodeCopyGuestWithAttributes(NULL, attributes, 0, &broker->code) == errSecSuccess
        && scribe_store_parent_is_current(broker);
    if (expression) CFRelease(expression); if (attributes) CFRelease(attributes); if (pid) CFRelease(pid);
    if (!valid) { scribe_store_parent_discard(broker); return NULL; }
    return broker;
}
static bool has_type(xpc_object_t value, xpc_type_t type) { return value && xpc_get_type(value) == type; }
xpc_object_t scribe_store_parent_reply(struct scribe_store_parent_broker *broker, xpc_object_t request) {
    if (!broker || !request || xpc_get_type(request) != XPC_TYPE_DICTIONARY
        || xpc_dictionary_get_count(request) != 4
        || !has_type(xpc_dictionary_get_value(request, "type"), XPC_TYPE_STRING)
        || strcmp(xpc_dictionary_get_string(request, "type"), "parent-proof")
        || !has_type(xpc_dictionary_get_value(request, "version"), XPC_TYPE_UINT64)
        || xpc_dictionary_get_uint64(request, "version") != 1
        || !has_type(xpc_dictionary_get_value(request, "sequence"), XPC_TYPE_UINT64)
        || !has_type(xpc_dictionary_get_value(request, "mode"), XPC_TYPE_STRING)
        || strcmp(xpc_dictionary_get_string(request, "mode"), broker->mode)) {
        if (broker) broker->invalid = true;
        return NULL;
    }
    uint64_t sequence = xpc_dictionary_get_uint64(request, "sequence");
    if (!sequence || sequence <= broker->sequence || !scribe_store_parent_is_current(broker)) {
        broker->invalid = true; return NULL;
    }
    broker->sequence = sequence;
    xpc_object_t reply = xpc_dictionary_create_reply(request);
    if (!reply) { broker->invalid = true; return NULL; }
    xpc_dictionary_set_string(reply, "type", "parent-proof");
    xpc_dictionary_set_uint64(reply, "version", 1);
    xpc_dictionary_set_uint64(reply, "sequence", sequence);
    xpc_dictionary_set_int64(reply, "host", broker->parent);
    xpc_dictionary_set_string(reply, "mode", broker->mode);
    xpc_dictionary_set_bool(reply, "valid", true);
    /* Last drain before the caller can forward the positive reply. */
    if (!scribe_store_parent_is_current(broker)) { xpc_release(reply); return NULL; }
    return reply;
}
bool scribe_store_parent_watch(struct scribe_store_parent_broker *broker, dispatch_queue_t queue, dispatch_block_t revoked) {
    if (!broker || broker->watching || !queue || !revoked || broker->invalid) return false;
    dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, (uintptr_t)broker->monitor, 0, queue);
    if (!source) { broker->invalid = true; return false; }
    broker->watching = true;
    dispatch_source_set_event_handler(source, ^{ if (!drain_monitor(broker)) revoked(); });
    /* Process-lifetime monitor; cancellation owns the descriptor close. */
    dispatch_source_set_cancel_handler(source, ^{ close(broker->monitor); broker->monitor = -1; });
    dispatch_resume(source);
    return true;
}
