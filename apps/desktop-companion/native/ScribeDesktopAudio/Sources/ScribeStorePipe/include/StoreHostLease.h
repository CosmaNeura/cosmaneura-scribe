#ifndef SCRIBE_STORE_HOST_LEASE_H
#define SCRIBE_STORE_HOST_LEASE_H
#include <stdbool.h>
#include <sys/types.h>

/* Listener-created native authority. No PID/Boolean/payload authority factory.
 * Foreign or released handles refuse safely; retain before asynchronous hops. */
struct scribe_store_host_lease;
struct scribe_store_host_lease *scribe_store_host_retain(struct scribe_store_host_lease *lease);
void scribe_store_host_release(struct scribe_store_host_lease *lease);
pid_t scribe_store_host_parent_pid(struct scribe_store_host_lease *lease);
bool scribe_store_host_is_current(struct scribe_store_host_lease *lease);
#endif
