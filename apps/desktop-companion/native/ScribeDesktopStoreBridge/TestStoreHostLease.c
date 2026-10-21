/* Production lease boundary with local dictionaries and synthetic process facts.
 * No connection is activated and no kernel process/Security lookup is performed.
 * Queue/semaphore execution is real; it does not qualify kernel/XPC admission. */
#include <Block.h>
#include <dispatch/dispatch.h>
#include <libproc.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <xpc/xpc.h>
#include "../ScribeDesktopAudio/Sources/ScribeStorePipe/StoreHostLeaseInternal.h"

static atomic_uint checks;
#define CHECK(value) do { atomic_fetch_add_explicit(&checks, 1, memory_order_relaxed); if (!(value)) { \
    fprintf(stderr, "lease_fixture_failure_line_%u\n", (unsigned)__LINE__); exit(1); \
} } while (0)

enum reply_fault {
    REPLY_OK, REPLY_NULL, REPLY_SCALAR, REPLY_MISSING, REPLY_EXTRA,
    REPLY_SUBSTITUTE, REPLY_WRONG_TYPE, REPLY_TYPE_VALUE, REPLY_VERSION_ZERO,
    REPLY_VERSION_TWO, REPLY_SEQUENCE_ZERO, REPLY_SEQUENCE_OLD,
    REPLY_SEQUENCE_FUTURE, REPLY_HOST, REPLY_MODE, REPLY_FALSE
};
enum process_fault { PROCESS_OK, PROCESS_SIZE, PROCESS_PARENT, PROCESS_UID,
    PROCESS_SECONDS, PROCESS_MICROSECONDS };
static const char *const keys[] = {"type", "version", "sequence", "host", "mode", "valid"};
static enum reply_fault reply_fault;
static enum process_fault process_fault;
static unsigned fault_key, process_fault_call, peer_fault_call;
static unsigned process_calls, peer_calls, sends, cancels;
static uint64_t last_sequence;
static xpc_connection_t expected_peer;
static bool hold_reply;
static xpc_handler_t held_handler;
static xpc_object_t held_reply;
static dispatch_queue_t held_queue;
static dispatch_queue_t sent_queue;
static bool advance_clock_on_final_fence;
static atomic_bool clock_advanced;

static int fixture_clock_gettime(clockid_t clock, struct timespec *value) {
    CHECK(clock == CLOCK_MONOTONIC);
    int status = clock_gettime(clock, value);
    if (status == 0 && atomic_load_explicit(&clock_advanced, memory_order_relaxed)) value->tv_sec++;
    return status;
}

static struct proc_bsdinfo generation(void) {
    struct proc_bsdinfo value = {0};
    value.pbi_ppid = 4242; value.pbi_uid = 501;
    value.pbi_start_tvsec = 1000; value.pbi_start_tvusec = 123;
    return value;
}
static uid_t fixture_getuid(void) { return 501; }
static pid_t fixture_peer_pid(xpc_connection_t peer) {
    CHECK(peer == expected_peer);
    peer_calls++;
    return peer_fault_call == peer_calls ? 4244 : 4243;
}
static int fixture_proc_pidinfo(int pid, int flavor, uint64_t argument,
    void *buffer, int size) {
    CHECK(pid == 4243 && flavor == PROC_PIDTBSDINFO && argument == 0);
    CHECK(size == (int)sizeof(struct proc_bsdinfo));
    process_calls++;
    struct proc_bsdinfo value = generation();
    if (process_calls == process_fault_call) {
        if (process_fault == PROCESS_SIZE) return size - 1;
        if (process_fault == PROCESS_PARENT) value.pbi_ppid++;
        if (process_fault == PROCESS_UID) value.pbi_uid++;
        if (process_fault == PROCESS_SECONDS) value.pbi_start_tvsec++;
        if (process_fault == PROCESS_MICROSECONDS) value.pbi_start_tvusec++;
    }
    if (advance_clock_on_final_fence && process_calls == 3)
        atomic_store_explicit(&clock_advanced, true, memory_order_relaxed);
    memcpy(buffer, &value, sizeof(value)); return size;
}
static void fixture_cancel(xpc_connection_t peer) {
    CHECK(peer == expected_peer); cancels++;
}
static xpc_object_t make_reply(uint64_t sequence) {
    if (reply_fault == REPLY_NULL) return NULL;
    if (reply_fault == REPLY_SCALAR) return xpc_string_create("parent-proof");
    xpc_object_t reply = xpc_dictionary_create_empty();
    xpc_dictionary_set_string(reply, "type", "parent-proof");
    xpc_dictionary_set_uint64(reply, "version", 1);
    xpc_dictionary_set_uint64(reply, "sequence", sequence);
    xpc_dictionary_set_int64(reply, "host", 4242);
    xpc_dictionary_set_string(reply, "mode", "--provider-v1");
    xpc_dictionary_set_bool(reply, "valid", true);
    if (reply_fault == REPLY_MISSING || reply_fault == REPLY_SUBSTITUTE) {
        xpc_dictionary_set_value(reply, keys[fault_key], NULL);
        if (reply_fault == REPLY_SUBSTITUTE) {
            xpc_dictionary_set_bool(reply, "unknown", true);
            CHECK(xpc_dictionary_get_count(reply) == 6);
        }
    } else if (reply_fault == REPLY_EXTRA) {
        xpc_dictionary_set_bool(reply, "unknown", true);
    } else if (reply_fault == REPLY_WRONG_TYPE) {
        /* Int/uint distinction and bool/string/number confusion stay strict. */
        if (fault_key == 1 || fault_key == 2)
            xpc_dictionary_set_int64(reply, keys[fault_key], 1);
        else if (fault_key == 3)
            xpc_dictionary_set_uint64(reply, keys[fault_key], 4242);
        else if (fault_key == 5)
            xpc_dictionary_set_string(reply, keys[fault_key], "true");
        else xpc_dictionary_set_bool(reply, keys[fault_key], true);
    } else if (reply_fault == REPLY_TYPE_VALUE)
        xpc_dictionary_set_string(reply, "type", "parent-proof-other");
    else if (reply_fault == REPLY_VERSION_ZERO)
        xpc_dictionary_set_uint64(reply, "version", 0);
    else if (reply_fault == REPLY_VERSION_TWO)
        xpc_dictionary_set_uint64(reply, "version", 2);
    else if (reply_fault == REPLY_SEQUENCE_ZERO)
        xpc_dictionary_set_uint64(reply, "sequence", 0);
    else if (reply_fault == REPLY_SEQUENCE_OLD)
        xpc_dictionary_set_uint64(reply, "sequence", sequence - 1);
    else if (reply_fault == REPLY_SEQUENCE_FUTURE)
        xpc_dictionary_set_uint64(reply, "sequence", sequence + 1);
    else if (reply_fault == REPLY_HOST)
        xpc_dictionary_set_int64(reply, "host", 4244);
    else if (reply_fault == REPLY_MODE)
        xpc_dictionary_set_string(reply, "mode", "--audio-v1");
    else if (reply_fault == REPLY_FALSE)
        xpc_dictionary_set_bool(reply, "valid", false);
    return reply;
}
static void fixture_send(xpc_connection_t peer, xpc_object_t message,
    dispatch_queue_t queue, xpc_handler_t handler) {
    CHECK(peer == expected_peer);
    CHECK(xpc_get_type(message) == XPC_TYPE_DICTIONARY);
    CHECK(xpc_dictionary_get_count(message) == 4);
    CHECK(xpc_get_type(xpc_dictionary_get_value(message, "type")) == XPC_TYPE_STRING);
    CHECK(strcmp(xpc_dictionary_get_string(message, "type"), "parent-proof") == 0);
    CHECK(xpc_get_type(xpc_dictionary_get_value(message, "version")) == XPC_TYPE_UINT64);
    CHECK(xpc_dictionary_get_uint64(message, "version") == 1);
    CHECK(xpc_get_type(xpc_dictionary_get_value(message, "sequence")) == XPC_TYPE_UINT64);
    uint64_t sequence = xpc_dictionary_get_uint64(message, "sequence");
    CHECK(sequence > last_sequence); last_sequence = sequence;
    CHECK(xpc_get_type(xpc_dictionary_get_value(message, "mode")) == XPC_TYPE_STRING);
    CHECK(strcmp(xpc_dictionary_get_string(message, "mode"), "--provider-v1") == 0);
    sends++;
    if (!sent_queue) { sent_queue = queue; dispatch_retain(queue); }
    else CHECK(sent_queue == queue);
    xpc_object_t reply = make_reply(sequence);
    xpc_handler_t copied = Block_copy(handler);
    if (hold_reply) {
        CHECK(!held_handler); held_handler = copied; held_reply = reply;
        held_queue = queue; dispatch_retain(queue);
    } else dispatch_async(queue, ^{
        copied(reply); if (reply) xpc_release(reply); Block_release(copied);
    });
}

#define getuid fixture_getuid
#define proc_pidinfo fixture_proc_pidinfo
#define xpc_connection_get_pid fixture_peer_pid
#define xpc_connection_send_message_with_reply fixture_send
#define xpc_connection_cancel fixture_cancel
#define clock_gettime fixture_clock_gettime
#include "../ScribeDesktopAudio/Sources/ScribeStorePipe/StoreHostLease.c"
#undef getuid
#undef proc_pidinfo
#undef xpc_connection_get_pid
#undef xpc_connection_send_message_with_reply
#undef xpc_connection_cancel
#undef clock_gettime

struct fixture {
    xpc_connection_t peer;
    dispatch_queue_t owner;
    struct scribe_store_host_lease *token;
    unsigned invalidations;
};
static void begin(struct fixture *fixture) {
    CHECK(!held_handler && !sent_queue && registry == NULL);
    reply_fault = REPLY_OK; process_fault = PROCESS_OK;
    fault_key = process_fault_call = peer_fault_call = 0;
    process_calls = peer_calls = sends = cancels = 0;
    last_sequence = 0; hold_reply = false;
    advance_clock_on_final_fence = false;
    atomic_store_explicit(&clock_advanced, false, memory_order_relaxed);
    *fixture = (struct fixture){0};
    fixture->peer = (xpc_connection_t)xpc_dictionary_create_empty();
    expected_peer = fixture->peer;
    fixture->owner = dispatch_queue_create("scribe.fixture.lease-owner", DISPATCH_QUEUE_SERIAL);
    struct proc_bsdinfo value = generation();
    struct fixture *target = fixture;
    fixture->token = scribe_store_host_create(fixture->peer, 4243, 4242,
        &value, "--provider-v1", fixture->owner, ^{ target->invalidations++; });
    CHECK(fixture->token != NULL);
    CHECK(scribe_store_host_parent_pid(fixture->token) == 4242);
}
static void drain_owner(struct fixture *fixture) { dispatch_sync(fixture->owner, ^{}); }
static void deliver_held(void) {
    CHECK(held_handler != NULL);
    xpc_handler_t handler = held_handler;
    xpc_object_t reply = held_reply;
    dispatch_queue_t queue = held_queue;
    held_handler = NULL; held_reply = NULL; held_queue = NULL;
    dispatch_async(queue, ^{
        handler(reply); if (reply) xpc_release(reply); Block_release(handler);
    });
    dispatch_sync(queue, ^{}); dispatch_release(queue);
}
static void end(struct fixture *fixture, bool failed) {
    CHECK(!held_handler);
    /* Semaphore signaling precedes callback return; explicitly join its queue. */
    if (sent_queue) { dispatch_sync(sent_queue, ^{}); dispatch_release(sent_queue); sent_queue = NULL; }
    drain_owner(fixture);
    CHECK(fixture->invalidations == (failed ? 1U : 0U));
    CHECK(cancels == (failed ? 1U : 0U));
    struct scribe_store_host_lease *old = fixture->token;
    scribe_store_host_release(old);
    CHECK(scribe_store_host_retain(old) == NULL);
    CHECK(!scribe_store_host_is_current(old));
    CHECK(scribe_store_host_parent_pid(old) == 0);
    scribe_store_host_release(old); /* Released and foreign handles are harmless. */
    CHECK(registry == NULL);
    xpc_release(fixture->peer); dispatch_release(fixture->owner);
    expected_peer = NULL;
}
static void assert_failed(struct fixture *fixture) {
    CHECK(!scribe_store_host_is_current(fixture->token));
    CHECK(scribe_store_host_parent_pid(fixture->token) == 0);
    CHECK(!scribe_store_host_is_current(fixture->token));
    scribe_store_host_invalidate(fixture->token);
    end(fixture, true);
}
static void reply_boundaries(void) {
    for (unsigned key = 0; key < 6; key++) {
        const enum reply_fault faults[] = {REPLY_MISSING, REPLY_SUBSTITUTE, REPLY_WRONG_TYPE};
        for (unsigned i = 0; i < sizeof(faults) / sizeof(faults[0]); i++) {
            struct fixture fixture; begin(&fixture);
            reply_fault = faults[i]; fault_key = key; assert_failed(&fixture);
        }
    }
    const enum reply_fault faults[] = {REPLY_NULL, REPLY_SCALAR, REPLY_EXTRA,
        REPLY_TYPE_VALUE, REPLY_VERSION_ZERO, REPLY_VERSION_TWO, REPLY_SEQUENCE_ZERO,
        REPLY_SEQUENCE_OLD, REPLY_SEQUENCE_FUTURE, REPLY_HOST, REPLY_MODE, REPLY_FALSE};
    for (unsigned i = 0; i < sizeof(faults) / sizeof(faults[0]); i++) {
        struct fixture fixture; begin(&fixture); reply_fault = faults[i]; assert_failed(&fixture);
    }
}
static void generation_boundaries(void) {
    const enum process_fault faults[] = {PROCESS_SIZE, PROCESS_PARENT, PROCESS_UID,
        PROCESS_SECONDS, PROCESS_MICROSECONDS};
    for (unsigned call = 1; call <= 3; call++) {
        for (unsigned i = 0; i < sizeof(faults) / sizeof(faults[0]); i++) {
            struct fixture fixture; begin(&fixture);
            process_fault = faults[i]; process_fault_call = call; assert_failed(&fixture);
            CHECK(sends == (call == 1 ? 0U : 1U));
        }
        struct fixture fixture; begin(&fixture); peer_fault_call = call;
        assert_failed(&fixture); CHECK(sends == (call == 1 ? 0U : 1U));
    }
}
static void successful_finish(void) {
    struct fixture fixture; begin(&fixture);
    CHECK(scribe_store_host_is_current(fixture.token));
    CHECK(scribe_store_host_is_current(fixture.token));
    CHECK(sends == 2 && last_sequence == 2);
    scribe_store_host_finish(fixture.token);
    CHECK(scribe_store_host_parent_pid(fixture.token) == 0);
    CHECK(!scribe_store_host_is_current(fixture.token));
    scribe_store_host_invalidate(fixture.token);
    end(&fixture, false);
}
static void retained_async_lifetime(void) {
    struct fixture fixture; begin(&fixture);
    struct scribe_store_host_lease *retained = scribe_store_host_retain(fixture.token);
    CHECK(retained == fixture.token); scribe_store_host_release(fixture.token);
    /* This external retain is the Swift/native asynchronous ownership contract. */
    CHECK(scribe_store_host_parent_pid(retained) == 4242);
    CHECK(scribe_store_host_is_current(retained));
    scribe_store_host_finish(retained); end(&fixture, false);
    struct scribe_store_host_lease *old = retained;
    begin(&fixture); CHECK(fixture.token != old);
    CHECK(scribe_store_host_retain(old) == NULL);
    scribe_store_host_finish(fixture.token); end(&fixture, false);
}
static void timeout_and_late_nonrevival(void) {
    struct fixture fixture; begin(&fixture);
    struct scribe_store_host_lease *retained = scribe_store_host_retain(fixture.token);
    CHECK(retained == fixture.token); hold_reply = true;
    struct timespec start, finish;
    CHECK(clock_gettime(CLOCK_MONOTONIC, &start) == 0);
    CHECK(!scribe_store_host_is_current(fixture.token));
    CHECK(clock_gettime(CLOCK_MONOTONIC, &finish) == 0);
    double elapsed = (double)(finish.tv_sec - start.tv_sec)
        + (double)(finish.tv_nsec - start.tv_nsec) / 1000000000.0;
    CHECK(elapsed < 2.0);
    drain_owner(&fixture); CHECK(fixture.invalidations == 1 && cancels == 1);
    scribe_store_host_release(fixture.token);
    CHECK(scribe_store_host_parent_pid(retained) == 0);
    deliver_held(); /* A valid reply after the absolute deadline cannot revive. */
    CHECK(!scribe_store_host_is_current(retained));
    CHECK(scribe_store_host_parent_pid(retained) == 0);
    end(&fixture, true);
}
static void foreign_handles(void) {
    struct scribe_store_host_lease *foreign = (struct scribe_store_host_lease *)(uintptr_t)0xface;
    CHECK(scribe_store_host_retain(NULL) == NULL);
    CHECK(scribe_store_host_retain(foreign) == NULL);
    CHECK(!scribe_store_host_is_current(foreign));
    CHECK(scribe_store_host_parent_pid(foreign) == 0);
    scribe_store_host_finish(foreign); scribe_store_host_invalidate(foreign);
    scribe_store_host_release(foreign); CHECK(registry == NULL);
}
static void final_fence_deadline(void) {
    struct fixture fixture; begin(&fixture);
    advance_clock_on_final_fence = true;
    CHECK(!scribe_store_host_is_current(fixture.token));
    CHECK(process_calls == 3 && sends == 1);
    CHECK(atomic_load_explicit(&clock_advanced, memory_order_relaxed));
    CHECK(scribe_store_host_parent_pid(fixture.token) == 0);
    CHECK(!scribe_store_host_is_current(fixture.token));
    end(&fixture, true);
}
int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--final-fence-deadline")) {
        final_fence_deadline();
        printf("store_host_lease_final_fence_deadline_checks_%u_passed\n",
            atomic_load_explicit(&checks, memory_order_relaxed));
        return 0;
    }
    CHECK(argc == 1);
    foreign_handles(); reply_boundaries(); generation_boundaries();
    successful_finish(); retained_async_lifetime(); timeout_and_late_nonrevival();
    final_fence_deadline();
    CHECK(!held_handler && registry == NULL);
    printf("store_host_lease_production_boundary_checks_%u_passed\n",
        atomic_load_explicit(&checks, memory_order_relaxed));
    return 0;
}
