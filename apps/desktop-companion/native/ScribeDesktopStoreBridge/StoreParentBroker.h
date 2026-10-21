#ifndef SCRIBE_STORE_PARENT_BROKER_H
#define SCRIBE_STORE_PARENT_BROKER_H
#include <dispatch/dispatch.h>
#include <stdbool.h>
#include <sys/types.h>
#include <xpc/xpc.h>
struct scribe_store_parent_broker;
/* Bridge-local only. Registration precedes the retained signed parent proof. */
struct scribe_store_parent_broker *scribe_store_parent_prepare(pid_t parent, const char *group, const char *mode);
bool scribe_store_parent_is_current(struct scribe_store_parent_broker *broker);
xpc_object_t scribe_store_parent_reply(struct scribe_store_parent_broker *broker, xpc_object_t request);
bool scribe_store_parent_watch(struct scribe_store_parent_broker *broker, dispatch_queue_t queue, dispatch_block_t revoked);
/* Used only before a watcher takes process-lifetime ownership. */
void scribe_store_parent_discard(struct scribe_store_parent_broker *broker);
#endif
