export declare const platforms: string[];
export declare const currentPlatform: string;
export declare function nativeSourceDigest(): Promise<string>;
export declare function attestedCommits(results: unknown): string[];
export declare function buildInputs(): string[];
export declare function buildInputsAt(commit: string, inputs?: string[]): string[] | null;
export declare function differingInputs(
  inputs: string[],
  head: string[],
  attested: string[] | null,
): string[];
export declare function matchingAttestation(
  results: unknown,
  inputs: string[],
  head: string[],
  inputsAt?: (commit: string, inputs: string[]) => string[] | null,
): {
  commit: string | null;
  commits: string[];
  mismatches: { commit: string; differing: string[] }[];
};
export declare function generateNativeAssets(mode?: string, out?: string): Promise<void>;
