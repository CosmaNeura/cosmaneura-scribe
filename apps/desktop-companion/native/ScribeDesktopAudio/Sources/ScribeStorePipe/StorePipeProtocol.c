#include "StorePipeProtocol.h"
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

const char *scribe_store_approved_group(void) {
#if SCRIBE_MAC_APP_STORE_XPC
    /* macOS Team-ID group: fence files only, never a Keychain access group. */
    return "JVV65668U6.com.cosmaneura.scribe.beta.desktop.store";
#else
    return NULL;
#endif
}
static bool type_is(xpc_object_t value, xpc_type_t type) { return value && xpc_get_type(value) == type; }
const char *scribe_store_service(enum scribe_store_role role) {
    switch (role) {
        case SCRIBE_AUTH: return "com.cosmaneura.scribe.beta.desktop.store.auth";
        case SCRIBE_AUDIO: return "com.cosmaneura.scribe.beta.desktop.audio";
        case SCRIBE_PRESENTATION: return "com.cosmaneura.scribe.beta.desktop.presentation";
        default: return NULL;
    }
}
enum scribe_store_role scribe_store_mode_role(const char *mode) {
    if (!mode) return 0;
    if (!strcmp(mode, "--provider-v1")) return SCRIBE_AUTH;
    const char *audio[] = {"--availability-v1", "--request-permissions-v1", "--microphone-availability-v1",
        "--microphone-permissions-v1", "--microphone-check-v1", "--capture-v2", "--capture-v3"};
    for (size_t i = 0; i < sizeof(audio) / sizeof(audio[0]); i++) if (!strcmp(mode, audio[i])) return SCRIBE_AUDIO;
    const char *presentation[] = {"--presentation-v1", "--presentation-v2", "--presentation-v3"};
    for (size_t i = 0; i < sizeof(presentation) / sizeof(presentation[0]); i++) if (!strcmp(mode, presentation[i])) return SCRIBE_PRESENTATION;
    return 0;
}

static bool channel(int fd, bool input) {
    struct stat info;
    if (fd < 0 || fstat(fd, &info) || info.st_uid != getuid()) return false;
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0) return false;
    if (S_ISFIFO(info.st_mode)) return (flags & O_ACCMODE) == (input ? O_RDONLY : O_WRONLY);
    /* libuv child stdio also uses connected AF_UNIX stream socket pairs. */
    if (!S_ISSOCK(info.st_mode)) return false;
    struct sockaddr_un address; socklen_t length = sizeof(address);
    int type = 0; socklen_t type_length = sizeof(type);
    return !getpeername(fd, (struct sockaddr *)&address, &length) && address.sun_family == AF_UNIX
        && !getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &type_length) && type == SOCK_STREAM;
}
bool scribe_store_pair(int input, int output) {
    return input != output && channel(input, true) && channel(output, false);
}
xpc_object_t scribe_store_open_message(const char *mode, int input, int output, pid_t host) {
    if (!scribe_store_mode_role(mode) || host <= 1 || !scribe_store_pair(input, output)) return NULL;
    xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
    xpc_dictionary_set_uint64(message, "version", 1);
    xpc_dictionary_set_string(message, "mode", mode);
    xpc_dictionary_set_fd(message, "input", input);
    xpc_dictionary_set_fd(message, "output", output);
    xpc_dictionary_set_int64(message, "host", host);
    return message;
}
bool scribe_store_decode_open(xpc_object_t message, enum scribe_store_role role, struct scribe_store_open *open) {
    if (!open || !scribe_store_service(role)) return false;
    *open = (struct scribe_store_open){.input = -1, .output = -1};
    if (!message || xpc_get_type(message) != XPC_TYPE_DICTIONARY || xpc_dictionary_get_count(message) != 5) return false;
    if (!type_is(xpc_dictionary_get_value(message, "version"), XPC_TYPE_UINT64)
        || xpc_dictionary_get_uint64(message, "version") != 1
        || !type_is(xpc_dictionary_get_value(message, "mode"), XPC_TYPE_STRING)
        || !type_is(xpc_dictionary_get_value(message, "input"), XPC_TYPE_FD)
        || !type_is(xpc_dictionary_get_value(message, "output"), XPC_TYPE_FD)
        || !type_is(xpc_dictionary_get_value(message, "host"), XPC_TYPE_INT64)) return false;
    const char *mode = xpc_dictionary_get_string(message, "mode");
    int64_t host = xpc_dictionary_get_int64(message, "host");
    if (scribe_store_mode_role(mode) != role || host <= 1 || host > INT32_MAX) return false;
    int input = xpc_dictionary_dup_fd(message, "input"), output = xpc_dictionary_dup_fd(message, "output");
    if (!scribe_store_pair(input, output)) { if (input >= 0) close(input); if (output >= 0) close(output); return false; }
    char *retained_mode = strdup(mode);
    if (!retained_mode) { close(input); close(output); return false; }
    *open = (struct scribe_store_open){.mode = retained_mode, .input = input, .output = output, .host = (pid_t)host};
    return true;
}
void scribe_store_close_open(struct scribe_store_open *open) {
    if (!open) return;
    if (open->input >= 0) close(open->input);
    if (open->output >= 0) close(open->output);
    free((void *)open->mode);
    *open = (struct scribe_store_open){.input = -1, .output = -1};
}
