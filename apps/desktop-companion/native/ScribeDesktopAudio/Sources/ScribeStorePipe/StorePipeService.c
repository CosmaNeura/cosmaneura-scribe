#include "StorePipeService.h"
#include "StorePeerRequirement.h"
#include <Block.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <dispatch/dispatch.h>
#include <libproc.h>
#include <os/log.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static enum scribe_store_role service_role;
static scribe_store_start start_worker;
static scribe_store_stop stop_worker;
static dispatch_queue_t queue;
static unsigned active;
static bool capture_active, exclusive_admitted;

/* First-refusal vocabulary, with a process-wide bound. No request-derived
 * value, identity, descriptor, PID, path or error description is emitted. */
static void service_diagnostic(unsigned stage) {
    static atomic_uint emitted;
    if (stage < 1 || stage > 32) return;
    unsigned count = atomic_load_explicit(&emitted, memory_order_relaxed);
    do {
        if (count >= 32) return;
    } while (!atomic_compare_exchange_weak_explicit(&emitted, &count, count + 1,
        memory_order_relaxed, memory_order_relaxed));
    os_log_t logger = os_log_create("com.cosmaneura.scribe.store.bootstrap", "listener");
    switch (stage) {
        case 1: os_log_error(logger, "SCRIBE_STORE_SERVICE:1"); break;
        case 2: os_log_error(logger, "SCRIBE_STORE_SERVICE:2"); break;
        case 3: os_log_error(logger, "SCRIBE_STORE_SERVICE:3"); break;
        case 4: os_log_error(logger, "SCRIBE_STORE_SERVICE:4"); break;
        case 5: os_log_error(logger, "SCRIBE_STORE_SERVICE:5"); break;
        case 6: os_log_error(logger, "SCRIBE_STORE_SERVICE:6"); break;
        case 7: os_log_error(logger, "SCRIBE_STORE_SERVICE:7"); break;
        case 8: os_log_error(logger, "SCRIBE_STORE_SERVICE:8"); break;
        case 9: os_log_error(logger, "SCRIBE_STORE_SERVICE:9"); break;
        case 10: os_log_error(logger, "SCRIBE_STORE_SERVICE:10"); break;
        case 11: os_log_error(logger, "SCRIBE_STORE_SERVICE:11"); break;
        case 12: os_log_error(logger, "SCRIBE_STORE_SERVICE:12"); break;
        case 13: os_log_error(logger, "SCRIBE_STORE_SERVICE:13"); break;
        case 14: os_log_error(logger, "SCRIBE_STORE_SERVICE:14"); break;
        case 15: os_log_error(logger, "SCRIBE_STORE_SERVICE:15"); break;
        case 16: os_log_error(logger, "SCRIBE_STORE_SERVICE:16"); break;
        case 17: os_log_error(logger, "SCRIBE_STORE_SERVICE:17"); break;
        case 18: os_log_error(logger, "SCRIBE_STORE_SERVICE:18"); break;
        case 19: os_log_error(logger, "SCRIBE_STORE_SERVICE:19"); break;
        case 20: os_log_error(logger, "SCRIBE_STORE_SERVICE:20"); break;
        case 21: os_log_error(logger, "SCRIBE_STORE_SERVICE:21"); break;
        case 22: os_log_error(logger, "SCRIBE_STORE_SERVICE:22"); break;
        case 23: os_log_error(logger, "SCRIBE_STORE_SERVICE:23"); break;
        case 24: os_log_error(logger, "SCRIBE_STORE_SERVICE:24"); break;
        case 25: os_log_error(logger, "SCRIBE_STORE_SERVICE:25"); break;
        case 26: os_log_error(logger, "SCRIBE_STORE_SERVICE:26"); break;
        case 27: os_log_error(logger, "SCRIBE_STORE_SERVICE:27"); break;
        case 28: os_log_error(logger, "SCRIBE_STORE_SERVICE:28"); break;
        case 29: os_log_error(logger, "SCRIBE_STORE_SERVICE:29"); break;
        case 30: os_log_error(logger, "SCRIBE_STORE_SERVICE:30"); break;
        case 31: os_log_error(logger, "SCRIBE_STORE_SERVICE:31"); break;
        case 32: os_log_error(logger, "SCRIBE_STORE_SERVICE:32"); break;
    }
    os_release(logger);
}

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
/* The host field is not authority. Bind it to the authenticated inherited
 * bridge's current kernel parent and revalidate the parent's signed identity. */
static bool verified_host(xpc_connection_t peer, pid_t host) {
    struct proc_bsdinfo process = {0};
    pid_t bridge = xpc_connection_get_pid(peer);
    if (bridge <= 1 || host <= 1 || proc_pidinfo(bridge, PROC_PIDTBSDINFO, 0, &process, sizeof(process)) != sizeof(process)
        || process.pbi_ppid != (uint32_t)host || process.pbi_uid != getuid()) return false;
    CFNumberRef pid = CFNumberCreate(NULL, kCFNumberIntType, &host);
    if (!pid) return false;
    const void *keys[] = {kSecGuestAttributePid}, *values[] = {pid};
    CFDictionaryRef attributes = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    SecCodeRef code = NULL; SecStaticCodeRef static_code = NULL; SecRequirementRef requirement = NULL;
    char text[768];
    int n = snprintf(text, sizeof(text), "anchor apple generic and identifier \"com.cosmaneura.scribe.beta.desktop.store\" and certificate leaf[subject.OU] = \"JVV65668U6\" and entitlement[\"com.apple.security.app-sandbox\"] exists and entitlement[\"com.apple.security.application-groups\"] = \"%s\"", scribe_store_approved_group());
    CFStringRef expression = n > 0 && (size_t)n < sizeof(text) ? CFStringCreateWithCString(NULL, text, kCFStringEncodingUTF8) : NULL;
    bool valid = attributes && expression && SecRequirementCreateWithString(expression, 0, &requirement) == errSecSuccess
        && SecCodeCopyGuestWithAttributes(NULL, attributes, 0, &code) == errSecSuccess
        && SecCodeCheckValidity(code, 0, requirement) == errSecSuccess
        && SecCodeCopyStaticCode(code, 0, &static_code) == errSecSuccess
        && code_boolean_is_true(static_code, CFSTR("com.apple.security.app-sandbox"));
    /* Recheck the kernel parent after signature work; reject exit/reparent races. */
    struct proc_bsdinfo after = {0};
    valid = valid && proc_pidinfo(bridge, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) == sizeof(after)
        && after.pbi_ppid == process.pbi_ppid && after.pbi_start_tvsec == process.pbi_start_tvsec
        && after.pbi_start_tvusec == process.pbi_start_tvusec;
    if (static_code) CFRelease(static_code); if (code) CFRelease(code); if (requirement) CFRelease(requirement); if (expression) CFRelease(expression);
    if (attributes) CFRelease(attributes); CFRelease(pid); return valid;
}
static bool is_capture(const char *mode) { return !strcmp(mode, "--capture-v2") || !strcmp(mode, "--capture-v3"); }

static void accept_peer(xpc_connection_t peer) {
    xpc_connection_set_target_queue(peer, queue);
    if (!scribe_store_require_bridge_peer(peer)) { service_diagnostic(1); xpc_connection_cancel(peer); return; }
    __block bool accepted = false, closing = false, finished = false, capture = false;
    __block struct scribe_store_open open = {.input = -1, .output = -1};
    xpc_connection_set_event_handler(peer, ^(xpc_object_t event) {
        if (xpc_get_type(event) == XPC_TYPE_ERROR) {
            if (!accepted) service_diagnostic(10);
            if (accepted && !closing && !finished) {
                closing = true;
                stop_worker(&open);
                /* An uncooperative audio stop cannot survive in a reused service.
                 * Presentation intentionally retains its unconfirmed-stop warning. */
                if (service_role == SCRIBE_AUTH || capture) {
                    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC), queue, ^{ if (!finished) _exit(70); });
                }
            }
            return;
        }
        if (accepted || (service_role != SCRIBE_AUDIO && exclusive_admitted) || active >= 8) {
            service_diagnostic(2); xpc_connection_cancel(peer); return;
        }
        if (xpc_connection_get_euid(peer) != getuid()) { service_diagnostic(3); xpc_connection_cancel(peer); return; }
        if (!scribe_store_decode_open(event, service_role, &open)) { service_diagnostic(5); xpc_connection_cancel(peer); return; }
        capture = is_capture(open.mode);
        if (!verified_host(peer, open.host)) {
            service_diagnostic(6);
            scribe_store_close_open(&open); xpc_connection_cancel(peer); return;
        }
        if (capture && capture_active) {
            service_diagnostic(7);
            scribe_store_close_open(&open); xpc_connection_cancel(peer); return;
        }
        xpc_object_t reply = xpc_dictionary_create_reply(event);
        if (!reply) { service_diagnostic(8); scribe_store_close_open(&open); xpc_connection_cancel(peer); return; }
        active++; if (capture) capture_active = true;
        if (service_role != SCRIBE_AUDIO) exclusive_admitted = true;
        accepted = true; xpc_retain(peer);
        /* The retained reply holds the documented XPC transaction while native
         * workers drain. No endpoint, path or credential crosses this boundary. */
        service_diagnostic(9);
        start_worker(&open, ^(int code) {
            dispatch_async(queue, ^{
                if (finished) return;
                finished = true; active--; if (capture) capture_active = false;
                scribe_store_close_open(&open);
                int result = code >= 0 && code <= 255 ? code : 70;
                xpc_dictionary_set_int64(reply, "code", result);
                xpc_connection_send_message(peer, reply);
                /* Only clean capture completion permits another capture. Its failure
                 * terminates the role service, retaining the process stop bound.
                 * A catalogue/probe failure cannot kill an unrelated capture. */
                if (service_role != SCRIBE_AUDIO || (capture && result != 0)) {
                    xpc_connection_send_barrier(peer, ^{ _exit(result); });
                } else {
                    xpc_connection_send_barrier(peer, ^{ xpc_connection_cancel(peer); });
                }
                xpc_release(reply); xpc_release(peer);
            });
        });
    });
    xpc_connection_activate(peer);
}

int scribe_store_service_run(enum scribe_store_role role, scribe_store_start start, scribe_store_stop stop) {
    service_diagnostic(11);
    if (!scribe_store_approved_group() || !scribe_store_service(role) || !start || !stop) { service_diagnostic(12); return 78; }
    service_role = role; start_worker = Block_copy(start); stop_worker = Block_copy(stop);
    queue = dispatch_queue_create("scribe.store.private-pipe", DISPATCH_QUEUE_SERIAL);
    xpc_main(accept_peer);
}
