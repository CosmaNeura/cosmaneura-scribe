import { isUuid } from "../../../review-ui/src/contracts";
import { record } from "./core-client";

export type ProviderSetup = "practice" | "activation";
export class ProviderSetupRequired extends Error {
  constructor(readonly setup: ProviderSetup) { super("scribe_account_setup_required"); }
}

/** Native revision and closed receiver data; this signal grants no workspace access. */
export function checkedProviderSetup(value: unknown, revision: string, nonce?: string): ProviderSetup | null {
  if (!record(value) || Object.keys(value).sort().join() !== "request_nonce,revision,setup,status,type"
    || value.type !== "scribe_account_setup_required" || value.status !== 409
    || value.revision !== revision || !isUuid(value.request_nonce)
    || value.request_nonce === "00000000-0000-0000-0000-000000000000"
    || nonce !== undefined && value.request_nonce !== nonce
    || value.setup !== "practice" && value.setup !== "activation") return null;
  return value.setup;
}
