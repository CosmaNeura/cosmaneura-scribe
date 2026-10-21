#include "StoreHostLeaseInternal.h"
#include <Block.h>
#include <pthread.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

/* Opaque tokens are never dereferenced or serialized. A monotonically unique
 * process-local registry key prevents stale handles aliasing reused storage. */
struct lease_state {
    struct scribe_store_host_lease *token;
    struct lease_state *next;
    unsigned references;
    pthread_mutex_t lock;
    bool invalid, pending;
    uint64_t sequence;
    xpc_connection_t peer;
    pid_t bridge, parent;
    struct proc_bsdinfo generation;
    char *mode;
    dispatch_queue_t replies, owner;
    dispatch_block_t invalidated;
};
static pthread_mutex_t registry_lock = PTHREAD_MUTEX_INITIALIZER;
static struct lease_state *registry;
static uintptr_t next_token;

static struct lease_state *acquire(struct scribe_store_host_lease *token) {
    pthread_mutex_lock(&registry_lock);
    struct lease_state *state = registry;
    while (state && state->token != token) state = state->next;
    if (state && state->references < UINT_MAX) state->references++; else state = NULL;
    pthread_mutex_unlock(&registry_lock);
    return state;
}
struct scribe_store_host_lease *scribe_store_host_retain(struct scribe_store_host_lease *token) {
    return acquire(token) ? token : NULL;
}
void scribe_store_host_release(struct scribe_store_host_lease *token) {
    pthread_mutex_lock(&registry_lock);
    struct lease_state **link = &registry;
    while (*link && (*link)->token != token) link = &(*link)->next;
    struct lease_state *state = *link;
    if (state && --state->references == 0) *link = state->next; else state = NULL;
    pthread_mutex_unlock(&registry_lock);
    if (!state) return;
    if (state->invalidated) Block_release(state->invalidated);
    xpc_release(state->peer); dispatch_release(state->replies); dispatch_release(state->owner);
    pthread_mutex_destroy(&state->lock); free(state->mode); free(state);
}
static void invalidate(struct lease_state *state, bool completed) {
    dispatch_block_t handler = NULL;
    pthread_mutex_lock(&state->lock);
    state->invalid = true;
    handler = state->invalidated; state->invalidated = NULL;
    pthread_mutex_unlock(&state->lock);
    if (handler && !completed) {
        xpc_connection_t peer = xpc_retain(state->peer);
        dispatch_async(state->owner, ^{
            handler(); /* Exact admitted request's stop path, after revocation. */
            xpc_connection_cancel(peer); /* Resolve pending replies; never retain a hung broker forever. */
            xpc_release(peer);
        });
    }
    if (handler) Block_release(handler);
}
void scribe_store_host_invalidate(struct scribe_store_host_lease *token) {
    struct lease_state *state = acquire(token);
    if (state) { invalidate(state, false); scribe_store_host_release(token); }
}
void scribe_store_host_finish(struct scribe_store_host_lease *token) {
    struct lease_state *state = acquire(token);
    if (state) { invalidate(state, true); scribe_store_host_release(token); }
}
pid_t scribe_store_host_parent_pid(struct scribe_store_host_lease *token) {
    struct lease_state *state = acquire(token); if (!state) return 0;
    pthread_mutex_lock(&state->lock); pid_t pid = state->invalid ? 0 : state->parent;
    pthread_mutex_unlock(&state->lock); scribe_store_host_release(token); return pid;
}
static bool same_bridge(struct lease_state *state) {
    struct proc_bsdinfo current = {0};
    return xpc_connection_get_pid(state->peer) == state->bridge
        && proc_pidinfo(state->bridge, PROC_PIDTBSDINFO, 0, &current, sizeof(current)) == sizeof(current)
        && current.pbi_ppid == (uint32_t)state->parent && current.pbi_uid == getuid()
        && current.pbi_ppid == state->generation.pbi_ppid
        && current.pbi_uid == state->generation.pbi_uid
        && current.pbi_start_tvsec == state->generation.pbi_start_tvsec
        && current.pbi_start_tvusec == state->generation.pbi_start_tvusec;
}
struct request_state {
    struct lease_state *lease;
    uint64_t sequence;
    struct timespec deadline;
    dispatch_semaphore_t done;
    bool success;
    unsigned references;
};
static void release_request(struct request_state *request) {
    pthread_mutex_lock(&registry_lock); bool last = --request->references == 0;
    pthread_mutex_unlock(&registry_lock);
    if (last) { scribe_store_host_release(request->lease->token); dispatch_release(request->done); free(request); }
}
static bool before_deadline(const struct request_state *request) {
    struct timespec now;
    return clock_gettime(CLOCK_MONOTONIC, &now) == 0
        && (now.tv_sec < request->deadline.tv_sec
            || (now.tv_sec == request->deadline.tv_sec && now.tv_nsec < request->deadline.tv_nsec));
}
static bool has_type(xpc_object_t value, xpc_type_t type) {
    return value && xpc_get_type(value) == type;
}
static bool reply_matches(struct request_state *request, xpc_object_t reply) {
    struct lease_state *state = request->lease;
    return reply && xpc_get_type(reply) == XPC_TYPE_DICTIONARY && xpc_dictionary_get_count(reply) == 6
        && has_type(xpc_dictionary_get_value(reply, "type"), XPC_TYPE_STRING)
        && !strcmp(xpc_dictionary_get_string(reply, "type"), "parent-proof")
        && has_type(xpc_dictionary_get_value(reply, "version"), XPC_TYPE_UINT64)
        && xpc_dictionary_get_uint64(reply, "version") == 1
        && has_type(xpc_dictionary_get_value(reply, "sequence"), XPC_TYPE_UINT64)
        && xpc_dictionary_get_uint64(reply, "sequence") == request->sequence
        && has_type(xpc_dictionary_get_value(reply, "host"), XPC_TYPE_INT64)
        && xpc_dictionary_get_int64(reply, "host") == state->parent
        && has_type(xpc_dictionary_get_value(reply, "mode"), XPC_TYPE_STRING)
        && !strcmp(xpc_dictionary_get_string(reply, "mode"), state->mode)
        && has_type(xpc_dictionary_get_value(reply, "valid"), XPC_TYPE_BOOL)
        && xpc_dictionary_get_bool(reply, "valid");
}
bool scribe_store_host_is_current(struct scribe_store_host_lease *token) {
    struct lease_state *state = acquire(token); if (!state) return false;
    pthread_mutex_lock(&state->lock);
    bool allowed = !state->invalid && !state->pending && state->sequence < UINT64_MAX;
    uint64_t sequence = allowed ? ++state->sequence : 0;
    if (allowed) state->pending = true;
    pthread_mutex_unlock(&state->lock);
    if (!allowed || !same_bridge(state)) {
        invalidate(state, false); scribe_store_host_release(token); return false;
    }
    struct request_state *request = calloc(1, sizeof(*request));
    if (!request) { invalidate(state, false); scribe_store_host_release(token); return false; }
    request->lease = state; request->sequence = sequence; request->references = 2;
    request->done = dispatch_semaphore_create(0); /* Own acquire above until both consumers drain. */
    if (!request->done || clock_gettime(CLOCK_MONOTONIC, &request->deadline) != 0) {
        if (request->done) dispatch_release(request->done);
        free(request); invalidate(state, false); scribe_store_host_release(token); return false;
    }
    request->deadline.tv_nsec += 250 * NSEC_PER_MSEC;
    if (request->deadline.tv_nsec >= (long)NSEC_PER_SEC) { request->deadline.tv_sec++; request->deadline.tv_nsec -= NSEC_PER_SEC; }
    xpc_object_t message = xpc_dictionary_create_empty();
    xpc_dictionary_set_string(message, "type", "parent-proof");
    xpc_dictionary_set_uint64(message, "version", 1);
    xpc_dictionary_set_uint64(message, "sequence", sequence);
    xpc_dictionary_set_string(message, "mode", state->mode);
    xpc_connection_send_message_with_reply(state->peer, message, state->replies, ^(xpc_object_t reply) {
        bool valid = before_deadline(request) && reply_matches(request, reply) && same_bridge(state);
        pthread_mutex_lock(&state->lock);
        request->success = valid && !state->invalid && state->pending && state->sequence == sequence;
        pthread_mutex_unlock(&state->lock);
        if (!request->success) invalidate(state, false);
        dispatch_semaphore_signal(request->done); release_request(request);
    });
    xpc_release(message);
    bool timely = dispatch_semaphore_wait(request->done, dispatch_time(DISPATCH_TIME_NOW, 250 * NSEC_PER_MSEC)) == 0;
    pthread_mutex_lock(&state->lock);
    bool valid = timely && before_deadline(request) && request->success && !state->invalid && state->sequence == sequence;
    pthread_mutex_unlock(&state->lock);
    bool kernel_current = valid && same_bridge(state);
    pthread_mutex_lock(&state->lock);
    valid = kernel_current && before_deadline(request) && !state->invalid && state->sequence == sequence;
    state->pending = false;
    pthread_mutex_unlock(&state->lock);
    if (!valid) invalidate(state, false);
    release_request(request); return valid;
}
struct scribe_store_host_lease *scribe_store_host_create(xpc_connection_t peer,
    pid_t bridge, pid_t parent, const struct proc_bsdinfo *generation,
    const char *mode, dispatch_queue_t owner, dispatch_block_t invalidated) {
    if (!peer || bridge <= 1 || parent <= 1 || !generation || !mode || !owner || !invalidated) return NULL;
    struct lease_state *state = calloc(1, sizeof(*state)); if (!state) return NULL;
    state->mode = strdup(mode);
    if (!state->mode || pthread_mutex_init(&state->lock, NULL)) { free(state->mode); free(state); return NULL; }
    state->peer = xpc_retain(peer); state->bridge = bridge; state->parent = parent;
    state->generation = *generation; state->owner = owner; dispatch_retain(owner);
    state->replies = dispatch_queue_create("scribe.store.parent-proof-replies", DISPATCH_QUEUE_SERIAL);
    state->invalidated = Block_copy(invalidated); state->references = 1;
    pthread_mutex_lock(&registry_lock);
    if (next_token == UINTPTR_MAX) {
        pthread_mutex_unlock(&registry_lock); Block_release(state->invalidated);
        xpc_release(state->peer); dispatch_release(state->replies); dispatch_release(state->owner);
        pthread_mutex_destroy(&state->lock); free(state->mode); free(state); return NULL;
    }
    state->token = (struct scribe_store_host_lease *)(++next_token);
    state->next = registry; registry = state;
    pthread_mutex_unlock(&registry_lock);
    return state->token;
}
