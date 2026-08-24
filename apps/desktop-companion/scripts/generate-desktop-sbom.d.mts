export interface DesktopSbom {
  readonly bomFormat: "CycloneDX";
  readonly specVersion: "1.6";
  readonly version: 1;
  readonly metadata: {
    readonly component: {
      readonly type: "application";
      readonly name: string;
      readonly version: string;
      readonly "bom-ref": string;
      readonly properties: readonly { readonly name: string; readonly value: string }[];
    };
  };
  readonly components: readonly Record<string, unknown>[];
  readonly dependencies: readonly {
    readonly ref: string;
    readonly dependsOn: readonly string[];
  }[];
}

export function generateDesktopSbom(target: string): Promise<DesktopSbom>;
export function parseArguments(argv: readonly string[]): Readonly<{
  target: string;
  out: string;
}>;
