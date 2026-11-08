export declare const platforms: string[];
export declare const currentPlatform: string;
export declare function nativeSourceDigest(): Promise<string>;
export declare function attestedCommits(results: unknown): string[];
export declare function nativeTreeAt(commit: string): string | null;
export declare function matchingAttestation(
  results: unknown,
  headTree: string,
  treeAt?: (commit: string) => string | null,
): { commit: string | null; commits: string[] };
export declare function generateNativeAssets(mode?: string, out?: string): Promise<void>;
