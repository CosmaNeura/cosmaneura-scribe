/* Fixed-artifact public CF-type proof only. Root binds the five argv paths and
 * their exact already-signed101 hashes before executing this fixture.
 * No SecCode mock is used. The production main is not called; neither dynamic
 * guest lookup, XPC, kernel identity, signature trust nor runtime is qualified. */
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#define main unused_production_bridge_main
#include "StorePipeBridge.c"
#undef main

int main(int argc, const char *argv[]) {
    if (argc != 6) return 64; /* parent, bridge, auth, audio, presentation */
    unsigned checks = 0;
    for (int index = 1; index < argc; index++) {
        if (argv[index][0] != '/') return 64;
        CFURLRef path = CFURLCreateFromFileSystemRepresentation(NULL,
            (const UInt8 *)argv[index], (CFIndex)strlen(argv[index]), false);
        SecStaticCodeRef code = NULL;
        bool valid = path && SecStaticCodeCreateWithPath(path, 0, &code) == errSecSuccess
            && code_boolean_is_true(code, CFSTR("com.apple.security.app-sandbox"));
        if (valid) checks++;
        if (valid && index == 2) {
            valid = code_boolean_is_true(code, CFSTR("com.apple.security.inherit"));
            if (valid) checks++;
        }
        if (code) CFRelease(code);
        if (path) CFRelease(path);
        if (!valid) { puts("store_signed_artifact_boolean_checks_failed"); return 78; }
    }
    if (checks != 6) return 78;
    puts("store_signed_artifact_six_positive_boolean_checks_passed_not_runtime_or_trust");
    return 0;
}
