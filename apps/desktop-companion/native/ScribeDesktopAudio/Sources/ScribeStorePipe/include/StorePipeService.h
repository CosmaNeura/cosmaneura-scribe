#ifndef SCRIBE_STORE_PIPE_SERVICE_H
#define SCRIBE_STORE_PIPE_SERVICE_H
#include "StorePipeProtocol.h"
/* The service owns descriptors through completion. Copy mode/host at admission,
 * retain the asynchronous completion block, and never close these descriptors.
 * Completion follows the existing native stop + writer + reader drain barriers.
 * The stop callback receives the same descriptor identity and only schedules
 * cancellation: it must not block the serial XPC queue or restart capture. */
typedef void (^scribe_store_completion)(int code);
typedef void (^scribe_store_start)(const struct scribe_store_open *open, scribe_store_completion completed);
typedef void (^scribe_store_stop)(const struct scribe_store_open *open);
int scribe_store_service_run(enum scribe_store_role role, scribe_store_start start, scribe_store_stop stop);
#endif
