#include "StorePipeProtocol.h"
#include "StorePeerRequirement.h"
#include "StoreParentBroker.h"
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <dispatch/dispatch.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

/* Closed diagnostic vocabulary only: no request, path, PID or XPC description.
 * Failure logging is best effort and never changes the existing result. */
static void bridge_diagnostic(unsigned code) {
    static const char *const markers[] = {NULL,
        "SCRIBE_STORE_BRIDGE:1\n", "SCRIBE_STORE_BRIDGE:2\n", "SCRIBE_STORE_BRIDGE:3\n",
        "SCRIBE_STORE_BRIDGE:4\n", "SCRIBE_STORE_BRIDGE:5\n", "SCRIBE_STORE_BRIDGE:6\n",
        "SCRIBE_STORE_BRIDGE:7\n", "SCRIBE_STORE_BRIDGE:8\n", "SCRIBE_STORE_BRIDGE:9\n",
        "SCRIBE_STORE_BRIDGE:10\n", "SCRIBE_STORE_BRIDGE:11\n", "SCRIBE_STORE_BRIDGE:12\n",
        "SCRIBE_STORE_BRIDGE:13\n", "SCRIBE_STORE_BRIDGE:14\n"};
    if (code > 0 && code < sizeof(markers) / sizeof(markers[0]))
        (void)write(STDERR_FILENO, markers[code], strlen(markers[code]));
}
static unsigned bridge_xpc_error_diagnostic(xpc_object_t error) {
    if (error == XPC_ERROR_CONNECTION_INVALID) return 10;
    if (error == XPC_ERROR_PEER_CODE_SIGNING_REQUIREMENT) return 11;
    if (error == XPC_ERROR_CONNECTION_INTERRUPTED) return 13;
    if (error == XPC_ERROR_TERMINATION_IMMINENT) return 14;
    return 9;
}


int main(int argc, const char *argv[]) {
    const char *group = scribe_store_approved_group();
    if (!group) { bridge_diagnostic(1); return 78; } /* Before code/container/XPC/forwarded descriptors. */
    if (argc != 2) { bridge_diagnostic(2); return 64; }
    enum scribe_store_role role = scribe_store_mode_role(argv[1]);
    const char *service = scribe_store_service(role); pid_t parent = getppid();
    if (!service || parent <= 1) { bridge_diagnostic(3); return 78; }
    struct scribe_store_parent_broker *broker = scribe_store_parent_prepare(parent, group, argv[1]);
    if (!broker) { bridge_diagnostic(4); return 78; }
    xpc_object_t message = scribe_store_open_message(argv[1], STDIN_FILENO, STDOUT_FILENO, parent);
    if (!message) { bridge_diagnostic(5); return 78; }
    dispatch_queue_t broker_queue = dispatch_queue_create("scribe.store.parent-proof", DISPATCH_QUEUE_SERIAL);
    xpc_connection_t connection = xpc_connection_create(service, broker_queue);
    if (!connection) { bridge_diagnostic(7); return 78; }
    if (!scribe_store_require_service_peer(connection, role)) { bridge_diagnostic(8); return 78; }
    xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
        if (xpc_get_type(event) == XPC_TYPE_ERROR) { bridge_diagnostic(bridge_xpc_error_diagnostic(event)); _exit(70); }
        xpc_object_t reply = scribe_store_parent_reply(broker, event);
        if (!reply) { xpc_connection_cancel(connection); _exit(70); }
        xpc_connection_send_message(connection, reply); xpc_release(reply);
    });
    if (!scribe_store_parent_watch(broker, broker_queue, ^{ xpc_connection_cancel(connection); _exit(70); })) {
        bridge_diagnostic(4); return 78;
    }
    __block bool current = false;
    dispatch_sync(broker_queue, ^{ current = scribe_store_parent_is_current(broker); });
    if (!current) { bridge_diagnostic(4); return 78; }
    xpc_connection_activate(connection);
    xpc_connection_send_message_with_reply(connection, message, dispatch_get_main_queue(), ^(xpc_object_t reply) {
        if (xpc_get_type(reply) == XPC_TYPE_ERROR) { bridge_diagnostic(bridge_xpc_error_diagnostic(reply)); _exit(70); }
        if (xpc_get_type(reply) != XPC_TYPE_DICTIONARY || xpc_dictionary_get_count(reply) != 1
            || !xpc_dictionary_get_value(reply, "code")
            || xpc_get_type(xpc_dictionary_get_value(reply, "code")) != XPC_TYPE_INT64) { bridge_diagnostic(12); _exit(70); }
        int64_t code = xpc_dictionary_get_int64(reply, "code");
        if (code < 0 || code > 255) bridge_diagnostic(12);
        _exit(code >= 0 && code <= 255 ? (int)code : 70);
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
