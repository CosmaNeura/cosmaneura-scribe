/* Actual LWCR constructor and typed synthetic signed facts. No connection is
 * activated; this fixture proves dictionary/query semantics, not kernel trust. */
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <assert.h>
#include <errno.h>
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

static bool fixture_available = true;
static int setter_result;
static unsigned setter_calls;
static xpc_object_t captured_policy;
static xpc_connection_t expected_connection;
static int fixture_lwcr_setter(xpc_connection_t connection, xpc_object_t requirement) {
    assert(connection == expected_connection && requirement
        && xpc_get_type(requirement) == XPC_TYPE_DICTIONARY);
    setter_calls++;
    if (captured_policy) xpc_release(captured_policy);
    captured_policy = xpc_retain(requirement);
    return setter_result;
}
#define __builtin_available(...) fixture_available
#define xpc_connection_set_peer_lightweight_code_requirement fixture_lwcr_setter
#include "../ScribeDesktopAudio/Sources/ScribeStorePipe/StorePeerRequirement.c"
#undef xpc_connection_set_peer_lightweight_code_requirement
#undef __builtin_available

/* Validate the actual constructor output before interpreting exactly the
 * documented select-key (1) and strict Boolean (5) operations. */
static void check_policy(const char *identifier, bool inherited) {
    assert(captured_policy && xpc_dictionary_get_count(captured_policy) == 4);
    assert(!strcmp(xpc_dictionary_get_string(captured_policy, "team-identifier"), "JVV65668U6"));
    assert(!strcmp(xpc_dictionary_get_string(captured_policy, "signing-identifier"), identifier));
    xpc_object_t validation = xpc_dictionary_get_value(captured_policy, "validation-category");
    assert(validation && xpc_get_type(validation) == XPC_TYPE_DICTIONARY
        && xpc_dictionary_get_count(validation) == 1);
    xpc_object_t categories = xpc_dictionary_get_value(validation, "$in");
    assert(categories && xpc_get_type(categories) == XPC_TYPE_ARRAY && xpc_array_get_count(categories) == 3);
    for (size_t index = 0; index < 3; index++) {
        xpc_object_t value = xpc_array_get_value(categories, index);
        assert(xpc_get_type(value) == XPC_TYPE_INT64 && xpc_int64_get_value(value) == (int64_t)index + 2);
    }
    xpc_object_t conjunction = xpc_dictionary_get_value(captured_policy, "$and-array");
    assert(conjunction && xpc_get_type(conjunction) == XPC_TYPE_ARRAY
        && xpc_array_get_count(conjunction) == (inherited ? 2u : 1u));
    for (size_t index = 0; index < xpc_array_get_count(conjunction); index++) {
        xpc_object_t tuple = xpc_array_get_value(conjunction, index);
        assert(xpc_get_type(tuple) == XPC_TYPE_ARRAY && xpc_array_get_count(tuple) == 2);
        assert(!strcmp(xpc_array_get_string(tuple, 0), "$and"));
        xpc_object_t fact = xpc_array_get_value(tuple, 1);
        assert(xpc_get_type(fact) == XPC_TYPE_DICTIONARY && xpc_dictionary_get_count(fact) == 1);
        xpc_object_t query = xpc_dictionary_get_value(fact, "entitlements");
        assert(query && xpc_get_type(query) == XPC_TYPE_DICTIONARY && xpc_dictionary_get_count(query) == 1);
        xpc_object_t operations = xpc_dictionary_get_value(query, "$query");
        assert(operations && xpc_get_type(operations) == XPC_TYPE_ARRAY && xpc_array_get_count(operations) == 2);
        xpc_object_t select = xpc_array_get_value(operations, 0), match = xpc_array_get_value(operations, 1);
        assert(xpc_get_type(select) == XPC_TYPE_ARRAY && xpc_array_get_count(select) == 2);
        assert(xpc_get_type(match) == XPC_TYPE_ARRAY && xpc_array_get_count(match) == 2);
        assert(xpc_get_type(xpc_array_get_value(select, 0)) == XPC_TYPE_INT64 && xpc_array_get_int64(select, 0) == 1);
        assert(!strcmp(xpc_array_get_string(select, 1), index == 0
            ? "com.apple.security.app-sandbox" : "com.apple.security.inherit"));
        assert(xpc_get_type(xpc_array_get_value(match, 0)) == XPC_TYPE_INT64 && xpc_array_get_int64(match, 0) == 5);
        assert(xpc_get_type(xpc_array_get_value(match, 1)) == XPC_TYPE_BOOL && xpc_array_get_bool(match, 1));
    }
}
static bool policy_accepts(const char *team, const char *identifier, int64_t category, xpc_object_t signed_claims) {
    if (!team || !identifier || !signed_claims || xpc_get_type(signed_claims) != XPC_TYPE_DICTIONARY
        || strcmp(team, xpc_dictionary_get_string(captured_policy, "team-identifier"))
        || strcmp(identifier, xpc_dictionary_get_string(captured_policy, "signing-identifier"))) return false;
    xpc_object_t categories = xpc_dictionary_get_value(
        xpc_dictionary_get_value(captured_policy, "validation-category"), "$in");
    bool category_allowed = false;
    for (size_t index = 0; index < xpc_array_get_count(categories); index++)
        category_allowed |= xpc_array_get_int64(categories, index) == category;
    if (!category_allowed) return false;
    xpc_object_t conjunction = xpc_dictionary_get_value(captured_policy, "$and-array");
    for (size_t index = 0; index < xpc_array_get_count(conjunction); index++) {
        xpc_object_t fact = xpc_array_get_value(xpc_array_get_value(conjunction, index), 1);
        xpc_object_t operations = xpc_dictionary_get_value(xpc_dictionary_get_value(fact, "entitlements"), "$query");
        const char *key = xpc_array_get_string(xpc_array_get_value(operations, 0), 1);
        xpc_object_t value = xpc_dictionary_get_value(signed_claims, key);
        if (!value || xpc_get_type(value) != XPC_TYPE_BOOL
            || xpc_bool_get_value(value) != xpc_array_get_bool(xpc_array_get_value(operations, 1), 1)) return false;
    }
    return true;
}

int main(void) {
    unsigned checks = 0;
    xpc_object_t synthetic_peer = xpc_dictionary_create_empty();
    expected_connection = (xpc_connection_t)synthetic_peer; /* Never activated. */
    xpc_object_t signed_claims = xpc_dictionary_create_empty();
    xpc_object_t values[] = {xpc_bool_create(true), xpc_bool_create(false), NULL, xpc_string_create("true"),
        xpc_int64_create(1), xpc_int64_create(0), xpc_array_create_empty(), xpc_dictionary_create_empty()};
    const char *identifiers[] = {"com.cosmaneura.scribe.beta.desktop.store.bridge", "com.cosmaneura.scribe.beta.desktop.store.auth",
        "com.cosmaneura.scribe.beta.desktop.audio", "com.cosmaneura.scribe.beta.desktop.presentation"};
    for (size_t policy_index = 0; policy_index < 4; policy_index++) {
        unsigned before = setter_calls;
        bool accepted = policy_index == 0 ? scribe_store_require_bridge_peer(expected_connection)
            : scribe_store_require_service_peer(expected_connection, (enum scribe_store_role)policy_index);
        assert(accepted && setter_calls == before + 1); checks++;
        check_policy(identifiers[policy_index], policy_index == 0); checks++;
        xpc_dictionary_set_bool(signed_claims, "com.apple.security.app-sandbox", true);
        xpc_dictionary_set_bool(signed_claims, "com.apple.security.inherit", true);
        for (int64_t category = 2; category <= 4; category++) {
            assert(policy_accepts("JVV65668U6", identifiers[policy_index], category, signed_claims)); checks++;
        }
        assert(!policy_accepts("OTHERTEAM", identifiers[policy_index], 3, signed_claims)); checks++;
        assert(!policy_accepts("JVV65668U6", "com.cosmaneura.scribe.beta.desktop", 3, signed_claims)); checks++;
        assert(!policy_accepts(NULL, identifiers[policy_index], 3, signed_claims)); checks++;
        assert(!policy_accepts("JVV65668U6", NULL, 3, signed_claims)); checks++;
        const int64_t disallowed[] = {-1, 0, 1, 5, 6, 7, 8, 9, 10, INT64_MAX};
        for (size_t index = 0; index < sizeof(disallowed) / sizeof(disallowed[0]); index++) {
            assert(!policy_accepts("JVV65668U6", identifiers[policy_index], disallowed[index], signed_claims)); checks++;
        }
        for (size_t index = 0; index < sizeof(values) / sizeof(values[0]); index++) {
            xpc_dictionary_set_value(signed_claims, "com.apple.security.app-sandbox", values[index]);
            assert(policy_accepts("JVV65668U6", identifiers[policy_index], 3, signed_claims) == (index == 0)); checks++;
            if (policy_index == 0) {
                xpc_dictionary_set_bool(signed_claims, "com.apple.security.app-sandbox", true);
                xpc_dictionary_set_value(signed_claims, "com.apple.security.inherit", values[index]);
                assert(policy_accepts("JVV65668U6", identifiers[policy_index], 3, signed_claims) == (index == 0)); checks++;
                xpc_dictionary_set_bool(signed_claims, "com.apple.security.inherit", true);
            }
        }
        assert(!policy_accepts("JVV65668U6", identifiers[policy_index], 3, NULL)); checks++;
        assert(!policy_accepts("JVV65668U6", identifiers[policy_index], 3, values[3])); checks++;
    }
    unsigned before = setter_calls;
    assert(!scribe_store_require_bridge_peer(NULL)); checks++;
    assert(!scribe_store_require_service_peer(NULL, SCRIBE_AUTH)); checks++;
    assert(!scribe_store_require_service_peer(expected_connection, (enum scribe_store_role)0)); checks++;
    assert(!scribe_store_require_service_peer(expected_connection, (enum scribe_store_role)99)); checks++;
    assert(setter_calls == before); checks++;
    fixture_available = false;
    assert(!scribe_store_require_bridge_peer(expected_connection)); checks++;
    assert(!scribe_store_require_service_peer(expected_connection, SCRIBE_AUTH)); checks++;
    assert(setter_calls == before); checks++;
    fixture_available = true; setter_result = EINVAL;
    assert(!scribe_store_require_bridge_peer(expected_connection) && setter_calls == before + 1); checks++;
    assert(!scribe_store_require_service_peer(expected_connection, SCRIBE_AUTH) && setter_calls == before + 2); checks++;
    setter_result = 0;
    assert(scribe_store_require_bridge_peer(expected_connection) && setter_calls == before + 3); checks++;
    for (size_t index = 0; index < sizeof(values) / sizeof(values[0]); index++) if (values[index]) xpc_release(values[index]);
    xpc_release(signed_claims); xpc_release(captured_policy); xpc_release(synthetic_peer);
    printf("store_lwcr_production_boundary_%s_checks_%u_passed\n", SCRIBE_TEST_BRIDGE ? "bridge" : "service", checks);
    return 0;
}
