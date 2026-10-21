#ifndef SCRIBE_STORE_HOST_LEASE_INTERNAL_H
#define SCRIBE_STORE_HOST_LEASE_INTERNAL_H
#include "include/StorePipeProtocol.h"
#include <dispatch/dispatch.h>
#include <libproc.h>
/* C listener only: never included in the public Swift module. */
struct scribe_store_host_lease *scribe_store_host_create(xpc_connection_t peer,
    pid_t bridge, pid_t parent, const struct proc_bsdinfo *generation,
    const char *mode, dispatch_queue_t owner_queue, dispatch_block_t invalidated);
void scribe_store_host_invalidate(struct scribe_store_host_lease *lease);
void scribe_store_host_finish(struct scribe_store_host_lease *lease);
#endif
