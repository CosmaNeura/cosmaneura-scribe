#ifndef SCRIBE_STORE_PIPE_PROTOCOL_H
#define SCRIBE_STORE_PIPE_PROTOCOL_H
#include <stdbool.h>
#include <stdint.h>
#include <sys/types.h>
#include <xpc/xpc.h>

#include "StoreHostLease.h"

enum scribe_store_role { SCRIBE_AUTH = 1, SCRIBE_AUDIO = 2, SCRIBE_PRESENTATION = 3 };
struct scribe_store_open { const char *mode; int input; int output; pid_t host; struct scribe_store_host_lease *lease; };
const char *scribe_store_service(enum scribe_store_role role);
enum scribe_store_role scribe_store_mode_role(const char *mode);
bool scribe_store_pair(int input, int output);
xpc_object_t scribe_store_open_message(const char *mode, int input, int output, pid_t host);
bool scribe_store_decode_open(xpc_object_t message, enum scribe_store_role role, struct scribe_store_open *open);
void scribe_store_close_open(struct scribe_store_open *open);
/* Fixed only in the explicit XPC build; NULL in every other target. */
const char *scribe_store_approved_group(void);
#endif
