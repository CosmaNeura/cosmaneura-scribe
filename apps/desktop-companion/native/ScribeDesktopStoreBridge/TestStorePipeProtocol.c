#include "StorePipeProtocol.h"
#include <assert.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/socket.h>
#include <unistd.h>

int main(void) {
    assert(scribe_store_approved_group() == NULL);
    assert(scribe_store_mode_role("--provider-v1") == SCRIBE_AUTH);
    assert(scribe_store_mode_role("--capture-v3") == SCRIBE_AUDIO);
    assert(scribe_store_mode_role("--presentation-v3") == SCRIBE_PRESENTATION);
    assert(!scribe_store_mode_role(NULL) && !scribe_store_mode_role("--capture-v4") && !scribe_store_service(99));
    int input[2], output[2]; assert(!pipe(input) && !pipe(output));
    assert(scribe_store_pair(input[0], output[1]));
    assert(!scribe_store_pair(input[1], output[0]) && !scribe_store_pair(input[0], input[0]));
    int file = open("/dev/null", O_RDWR); assert(file >= 0 && !scribe_store_pair(file, output[1])); close(file);
    int sockin[2], sockout[2]; assert(!socketpair(AF_UNIX, SOCK_STREAM, 0, sockin) && !socketpair(AF_UNIX, SOCK_STREAM, 0, sockout));
    assert(scribe_store_pair(sockin[0], sockout[0]));
    assert(!scribe_store_open_message("--unknown", input[0], output[1], 42));
    assert(!scribe_store_open_message("--capture-v2", input[0], output[1], 1));
    xpc_object_t message = scribe_store_open_message("--capture-v2", input[0], output[1], 42); assert(message);
    struct scribe_store_open decoded;
    assert(scribe_store_decode_open(message, SCRIBE_AUDIO, &decoded));
    assert(decoded.host == 42 && decoded.input != input[0] && decoded.output != output[1]);
    scribe_store_close_open(&decoded); assert(decoded.input == -1 && decoded.output == -1);
    assert(!scribe_store_decode_open(message, SCRIBE_AUTH, &decoded));
    xpc_dictionary_set_bool(message, "version", true); assert(!scribe_store_decode_open(message, SCRIBE_AUDIO, &decoded));
    xpc_dictionary_set_uint64(message, "version", 1); xpc_dictionary_set_string(message, "extra", "no");
    assert(!scribe_store_decode_open(message, SCRIBE_AUDIO, &decoded)); xpc_dictionary_set_value(message, "extra", NULL);
    xpc_dictionary_set_value(message, "version", NULL); xpc_dictionary_set_string(message, "wrong-key", "no");
    assert(!scribe_store_decode_open(message, SCRIBE_AUDIO, &decoded)); xpc_dictionary_set_value(message, "wrong-key", NULL);
    xpc_dictionary_set_uint64(message, "version", 1);
    xpc_dictionary_set_int64(message, "host", INT64_MAX); assert(!scribe_store_decode_open(message, SCRIBE_AUDIO, &decoded));
    xpc_release(message);
    for (int i = 0; i < 2; i++) { close(input[i]); close(output[i]); close(sockin[i]); close(sockout[i]); }
    puts("store_pipe_protocol_pure_checks_passed"); return 0;
}
