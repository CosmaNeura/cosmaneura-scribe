#include "StorePipeProtocol.h"
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <dispatch/dispatch.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

/* The inherited shim has no native Keychain claim. It authenticates its actual
 * Electron parent before forwarding fixed stdio descriptors to a private XPC service. */
static bool parent_is_store_host(pid_t parent, const char *group) {
    CFNumberRef pid = CFNumberCreate(NULL, kCFNumberIntType, &parent);
    const void *keys[] = {kSecGuestAttributePid}; const void *values[] = {pid};
    CFDictionaryRef attributes = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    SecCodeRef code = NULL; SecRequirementRef requirement = NULL;
    char text[768];
    int length = snprintf(text, sizeof(text), "anchor apple generic and identifier \"com.cosmaneura.scribe.beta.desktop\" and certificate leaf[subject.OU] = \"JVV65668U6\" and entitlement[\"com.apple.security.app-sandbox\"] = true and entitlement[\"com.apple.security.application-groups\"] = \"%s\"", group);
    CFStringRef expression = length > 0 && (size_t)length < sizeof(text) ? CFStringCreateWithCString(NULL, text, kCFStringEncodingUTF8) : NULL;
    bool valid = expression && SecRequirementCreateWithString(expression, 0, &requirement) == errSecSuccess
        && SecCodeCopyGuestWithAttributes(NULL, attributes, 0, &code) == errSecSuccess
        && SecCodeCheckValidity(code, 0, requirement) == errSecSuccess;
    if (code) CFRelease(code); if (requirement) CFRelease(requirement); if (expression) CFRelease(expression);
    CFRelease(attributes); CFRelease(pid); return valid;
}

int main(int argc, const char *argv[]) {
    const char *group = scribe_store_approved_group();
    if (!group) return 78; /* Before code/container/XPC/descriptor actions. */
    if (argc != 2) return 64;
    enum scribe_store_role role = scribe_store_mode_role(argv[1]);
    const char *service = scribe_store_service(role); pid_t parent = getppid();
    if (!service || parent <= 1 || !parent_is_store_host(parent, group)) return 78;
    xpc_object_t message = scribe_store_open_message(argv[1], STDIN_FILENO, STDOUT_FILENO, parent);
    if (!message) return 78;
    char requirement[512];
    int length = snprintf(requirement, sizeof(requirement), "anchor apple generic and identifier \"%s\" and certificate leaf[subject.OU] = \"JVV65668U6\" and entitlement[\"com.apple.security.app-sandbox\"] = true", service);
    if (length <= 0 || (size_t)length >= sizeof(requirement)) return 78;
    xpc_connection_t connection = xpc_connection_create(service, dispatch_get_main_queue());
    if (!connection || xpc_connection_set_peer_code_signing_requirement(connection, requirement)) return 78;
    xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
        if (xpc_get_type(event) == XPC_TYPE_ERROR) _exit(70);
    });
    xpc_connection_activate(connection);
    xpc_connection_send_message_with_reply(connection, message, dispatch_get_main_queue(), ^(xpc_object_t reply) {
        if (xpc_get_type(reply) != XPC_TYPE_DICTIONARY || xpc_dictionary_get_count(reply) != 1
            || !xpc_dictionary_get_value(reply, "code")
            || xpc_get_type(xpc_dictionary_get_value(reply, "code")) != XPC_TYPE_INT64) _exit(70);
        int64_t code = xpc_dictionary_get_int64(reply, "code"); _exit(code >= 0 && code <= 255 ? (int)code : 70);
    });
    xpc_release(message);
    for (int signal_number = SIGINT; signal_number <= SIGTERM; signal_number += SIGTERM - SIGINT) {
        signal(signal_number, SIG_IGN);
        dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, (uintptr_t)signal_number, 0, dispatch_get_main_queue());
        dispatch_source_set_event_handler(source, ^{ xpc_connection_cancel(connection); _exit(70); });
        dispatch_resume(source);
    }
    dispatch_main();
}
