#ifndef SCRIBE_STORE_PEER_REQUIREMENT_H
#define SCRIBE_STORE_PEER_REQUIREMENT_H
#include "StorePipeProtocol.h"

/* One authenticated incoming-message/reply policy per connection. Older
 * systems and any setter error refuse admission without another API family. */
bool scribe_store_require_bridge_peer(xpc_connection_t connection);
bool scribe_store_require_service_peer(xpc_connection_t connection, enum scribe_store_role role);
#endif
