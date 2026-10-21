#include "StorePeerRequirement.h"

/* Apple entitlement-query operation5 requires an actual Boolean equal to true.
 * Repeated entitlement facts use the documented $and-array tuple grammar. */
static void require_true_entitlement(xpc_object_t conjunction, const char *key) {
    xpc_object_t select = xpc_array_create_empty();
    xpc_array_set_int64(select, XPC_ARRAY_APPEND, 1);
    xpc_array_set_string(select, XPC_ARRAY_APPEND, key);
    xpc_object_t match = xpc_array_create_empty();
    xpc_array_set_int64(match, XPC_ARRAY_APPEND, 5);
    xpc_array_set_bool(match, XPC_ARRAY_APPEND, true);
    xpc_object_t operations = xpc_array_create_empty();
    xpc_array_set_value(operations, XPC_ARRAY_APPEND, select);
    xpc_array_set_value(operations, XPC_ARRAY_APPEND, match);
    xpc_object_t query = xpc_dictionary_create_empty();
    xpc_dictionary_set_value(query, "$query", operations);
    xpc_object_t fact = xpc_dictionary_create_empty();
    xpc_dictionary_set_value(fact, "entitlements", query);
    xpc_object_t tuple = xpc_array_create_empty();
    xpc_array_set_string(tuple, XPC_ARRAY_APPEND, "$and");
    xpc_array_set_value(tuple, XPC_ARRAY_APPEND, fact);
    xpc_array_set_value(conjunction, XPC_ARRAY_APPEND, tuple);
    xpc_release(tuple); xpc_release(fact); xpc_release(query);
    xpc_release(operations); xpc_release(match); xpc_release(select);
}

static bool require_peer(xpc_connection_t connection, const char *identifier, bool inherited) {
    if (!connection || !identifier) return false;
    if (__builtin_available(macOS 14.4, *)) {
        xpc_object_t policy = xpc_dictionary_create_empty();
        xpc_dictionary_set_string(policy, "team-identifier", "JVV65668U6");
        xpc_dictionary_set_string(policy, "signing-identifier", identifier);
        xpc_object_t categories = xpc_array_create_empty();
        /* TestFlight, Apple Development, App Store. No ad-hoc or unknown class. */
        xpc_array_set_int64(categories, XPC_ARRAY_APPEND, 2);
        xpc_array_set_int64(categories, XPC_ARRAY_APPEND, 3);
        xpc_array_set_int64(categories, XPC_ARRAY_APPEND, 4);
        xpc_object_t allowed = xpc_dictionary_create_empty();
        xpc_dictionary_set_value(allowed, "$in", categories);
        xpc_dictionary_set_value(policy, "validation-category", allowed);
        xpc_object_t conjunction = xpc_array_create_empty();
        require_true_entitlement(conjunction, "com.apple.security.app-sandbox");
        if (inherited) require_true_entitlement(conjunction, "com.apple.security.inherit");
        xpc_dictionary_set_value(policy, "$and-array", conjunction);
        int result = xpc_connection_set_peer_lightweight_code_requirement(connection, policy);
        xpc_release(conjunction); xpc_release(allowed); xpc_release(categories); xpc_release(policy);
        return result == 0;
    }
    return false;
}

bool scribe_store_require_bridge_peer(xpc_connection_t connection) {
    return require_peer(connection, "com.cosmaneura.scribe.beta.desktop.store.bridge", true);
}
bool scribe_store_require_service_peer(xpc_connection_t connection, enum scribe_store_role role) {
    return require_peer(connection, scribe_store_service(role), false);
}
