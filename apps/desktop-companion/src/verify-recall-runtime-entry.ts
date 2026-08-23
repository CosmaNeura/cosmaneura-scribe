import { verifyRecallSdkRuntime } from "./recall-sdk-loader.js";

try {
  const evidence = await verifyRecallSdkRuntime();
  if (evidence.clinicalReleaseApproved !== false) {
    throw new Error("Prepared verification requires the clinical gate to remain disabled");
  }
  process.stdout.write(
    "Prepared Recall SDK source, archives, receipt, and native tree verified; clinical release remains disabled.\n",
  );
} catch {
  process.stderr.write("Prepared Recall SDK runtime verification failed.\n");
  process.exitCode = 1;
}
