import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";

/** Parent runner supplies an approved broker and separate synthetic-only judge. */
export async function makeSuite({ brokerModule, fixtureManifest, schemaRef, pythonExecutable, judgeProvider }) {
  if (![brokerModule, fixtureManifest, pythonExecutable].every(v => typeof v === "string" && isAbsolute(v)))
    throw new Error("evaluation_broker_fixture_and_python_required");
  const truth = JSON.parse(await readFile(new URL("./visit.json", import.meta.url)));
  return {
    description: "Fixed synthetic Scribe speech-to-Core-note evaluation",
    writeLatestResults: false,
    prompts: ["{{case_id}}"],
    providers: [{ id: fileURLToPath(new URL("./core-provider.mjs", import.meta.url)),
      config: { brokerModule, fixtureManifest, schemaRef } }],
    tests: [{ vars: { case_id: truth.case_id, python_executable: pythonExecutable, fixture_manifest: fixtureManifest },
      assert: [
        { type: "javascript", value: new URL("./assertion.mjs", import.meta.url).href },
        ...(judgeProvider ? [{ type: "llm-rubric", provider: judgeProvider,
          value: `${truth.rubric}\nSpoken reference turns:\n${truth.turns.map((t, i) => `${i}: ${t.speaker_role}: ${t.content}`).join("\n")}` }] : []),
      ] }],
  };
}
