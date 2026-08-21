import { createHash } from "node:crypto";

export const SAFE_SETUP_SOURCE = `"use strict";

throw new Error(
  "Recall native installation is disabled; use the verified Cosmas desktop preparation command.",
);
`;

const PATCHES = Object.freeze([
  Object.freeze({
    label: "event payload logging",
    before: `    if (type !== "upload-progress" && type !== "realtime-event" && type !== "log") {
        doLog("info", ["Receiving event: " + type + " | " + sortedStringify(payload)], false);
    }`,
    after: `    if (type !== "upload-progress" && type !== "realtime-event" && type !== "log") {
        doLog("info", ["Receiving event: " + type], false);
    }`,
  }),
  Object.freeze({
    label: "command payload logging",
    before: `        if (!options.suppressSendLog && command !== "log") {
            doLog("info", [\`Sending command [\${writeSequence}]: \` + payloadStr], false);
        }`,
    after: `        if (!options.suppressSendLog && command !== "log") {
            doLog("info", [\`Sending command [\${writeSequence}]: \${command}\`], false);
        }`,
  }),
  Object.freeze({
    label: "ambient Recall environment forwarding",
    before: `    let envExtra = {};
    // forward all env starting with RECALL_
    Object.keys(process.env).forEach(key => {
        if (key.startsWith("RECALL_")) {
            envExtra[key] = process.env[key];
        }
    });`,
    after: `    // Cosmas never forwards ambient RECALL_* values to the native child.
    let envExtra = {};`,
  }),
  Object.freeze({
    label: "automatic restart default",
    before: `    if (options.restartOnError === undefined) {
        options.restartOnError = true;
    }`,
    after: `    if (options.restartOnError === undefined) {
        options.restartOnError = false;
    }`,
  }),
  Object.freeze({
    label: "ambient Windows GStreamer override",
    before: `    if (process.platform === "win32" && process.env.GLOBAL_GST_RECALL !== "1") {
        envExtra["GST_PLUGIN_PATH"] = path.join(path.dirname(exe_path), "gstreamer-1.0");
    }`,
    after: `    if (process.platform === "win32") {
        envExtra["GST_PLUGIN_PATH"] = path.join(path.dirname(exe_path), "gstreamer-1.0");
    }`,
  }),
  Object.freeze({
    label: "ambient native debug dump switch",
    before: `    const gst_dump_dir = process.env.RECALLAI_DESKTOP_SDK_DEV ? path.join(os.tmpdir(), "gst.nocommit") : os.tmpdir();`,
    after: `    const gst_dump_dir = os.tmpdir();`,
  }),
  Object.freeze({
    label: "ambient native verbose logging switch",
    before: `    const annotatorDebug = process.env.RECALLAI_DESKTOP_SDK_DEV ? ",transcriptspeakerannotator:4" : "";`,
    after: `    const annotatorDebug = "";`,
  }),
  Object.freeze({
    label: "native Recall debug verbosity",
    before: `            GST_RECALL_DEBUG: "2,transcriber:4,rtewebsocketsink:4,rtewebhooksink:4,audiomixer:4,galleryview:4,dsdks3sink:5" + annotatorDebug,`,
    after: `            GST_RECALL_DEBUG: "0" + annotatorDebug,`,
  }),
  Object.freeze({
    label: "native GStreamer debug verbosity",
    before: `            GST_DEBUG: "3,GST_CAPS:3,GST_SCHEDULING:2,GST_PADS:2,video-scaler:1,transcriber:4,filebuffereds3sink:4,seekables3sink:4,rtpsession:1,audioresample:1,videodecoder:2,basesink:2,webrtcbin:2,websocketsink:4,audiomixer:4,galleryview:4,removeonsinkeosbin:4,fallbackswitch:6,sendmessageonsinkeosbin:4,dsdks3sink:5" + annotatorDebug,`,
    after: `            GST_DEBUG: "0" + annotatorDebug,`,
  }),
  Object.freeze({
    label: "native GStreamer graph dump",
    before: `            GST_DEBUG_DUMP_DOT_DIR: gst_dump_dir,`,
    after: ``,
  }),
  Object.freeze({
    label: "native Rust backtrace",
    before: `            RUST_BACKTRACE: "full",`,
    after: `            RUST_BACKTRACE: "0",`,
  }),
  Object.freeze({
    label: "automatic restart stderr replay",
    before: `            logError(\`Last error output from Desktop SDK:\\n\${lastErrorOut.join("\\n")}\`);`,
    after: `            logError("Desktop SDK process emitted redacted error output.");`,
  }),
  Object.freeze({
    label: "native stdout development echo",
    before: `        else {
            if (process.env.RECALLAI_DESKTOP_SDK_DEV) {
                console.log(line);
            }
        }`,
    after: `        else {
            // Native stdout is intentionally suppressed because it may contain meeting data.
        }`,
  }),
  Object.freeze({
    label: "native stderr retention and echo",
    before: `    rlStderr.on('line', (line) => {
        appendError(line);
        if (process.env.RECALLAI_DESKTOP_SDK_DEV) {
            console.error(line);
        }
    });`,
    after: `    rlStderr.on('line', () => {
        appendError("[redacted native stderr]");
    });`,
  }),
  Object.freeze({
    label: "incoming parse error payload",
    before: `            catch (err) {
                logError("Desktop SDK: Failed to parse incoming data:", String(err));
            }`,
    after: `            catch {
                logError("Desktop SDK: Failed to parse redacted incoming data.");
            }`,
  }),
]);

export function patchRecallWrapper(source) {
  let patched = source;
  for (const { label, before, after } of PATCHES) {
    const first = patched.indexOf(before);
    const last = patched.lastIndexOf(before);
    if (first < 0 || first !== last) {
      throw new Error(`Recall wrapper patch mismatch: ${label}`);
    }
    patched = patched.replace(before, after);
  }
  return patched;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
