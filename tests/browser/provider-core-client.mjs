// Actual provider client through the Python server transport; all data is invented.
import { createInterface } from "node:readline";
import { CoreCaptureClient } from "../../apps/capture/src/provider/core-client.ts";
import { preferredNoteTemplate } from "../../apps/capture/src/provider/core-notes.ts";

const { scope, session } = JSON.parse(process.argv[2]);
const input = createInterface({ input: process.stdin });
let waiting;
input.on("line", line => {
  const value = JSON.parse(line);
  const resolve = waiting;
  waiting = undefined;
  resolve(Response.json(value));
});
const request = (path, body, key) => new Promise(resolve => {
  if (waiting) throw new Error("Unexpected concurrent fixture request");
  waiting = resolve;
  process.stdout.write(JSON.stringify({ path, body, key }) + "\n");
});
const client = new CoreCaptureClient(scope, request, new AbortController().signal);
const admitted = await client.admit({
  key: crypto.randomUUID(), languageMode: "en-US+es-US",
  attestation: { modality: "in_person", participant_regions: ["US-NY"],
    method: "verbal_attestation", all_parties_consented: true, granted_at: new Date().toISOString() },
});
if (admitted !== session) throw new Error("Wrong session");
await client.operation(session, { kind: "creator_review" });
await client.operation(session, { kind: "decide_translation", payload: {
  schema_version: "1.0", source_segment_id: crypto.randomUUID(), translation_id: crypto.randomUUID(),
  expected_source_transcript_version: 1, expected_source_segment_version: 1,
  expected_translation_version: 1, decision: "accepted",
} });
const schema = "doctor_note_schema_01j00000000000000000000000";
const edit = {
  client_key: crypto.randomUUID(), expected_note_ref: "visit_note_01j00000000000000000000000",
  expected_note_sha256: "a".repeat(64), expected_source_sha256: "b".repeat(64),
  fields: { Plan: "Invented follow-up plan" },
};
await client.note(session, "templates");
if (await preferredNoteTemplate(client, session, [{ schema_ref: schema, note_type: "Synthetic SOAP", field_names: ["Plan"] }]) !== null) {
  throw new Error("Wrong default preference");
}
for (const action of ["read", "prepare"]) await client.note(session, action, schema);
for (const action of ["save", "resolve"]) await client.note(session, action, schema, edit, edit.client_key);
process.stdout.write(JSON.stringify({ done: true }) + "\n");
input.close();
