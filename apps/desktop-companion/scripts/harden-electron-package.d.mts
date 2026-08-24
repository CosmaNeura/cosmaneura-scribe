export interface HardeningRequest {
  readonly application: string;
  readonly assemblyReceipt: string;
  readonly out: string;
  readonly sourceSha: string;
}

export function parseArguments(values: readonly string[]): HardeningRequest;
export function verifyFuses(
  executablePath: string,
): Promise<Readonly<Record<string, number | string>>>;
