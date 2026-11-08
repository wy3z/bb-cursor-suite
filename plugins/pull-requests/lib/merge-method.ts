export type MergeMethod = "merge" | "squash" | "rebase";

export const MERGE_METHOD_ORDER: readonly MergeMethod[] = ["merge", "squash", "rebase"];

export const MERGE_METHOD_LABEL: Record<MergeMethod, string> = {
  merge: "Merge",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

export const MERGE_METHOD_MENU_LABEL: Record<MergeMethod, string> = {
  ...MERGE_METHOD_LABEL,
  merge: "Create a merge commit",
};

export const MERGE_SETTINGS_UNKNOWN = "Couldn’t read this repo’s merge settings";

export interface MergeSettings {
  allowed: MergeMethod[];
  defaultMethod: MergeMethod | null;
}

export interface MergeChoices {
  primary: MergeMethod;
  others: MergeMethod[];
  known: boolean;
}

export const MERGE_SETTINGS_QUERY =
  "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerDefaultMergeMethod } }";

export function mergeSettingsFrom(repository: unknown): MergeSettings | null {
  if (!repository || typeof repository !== "object") return null;
  const fields = repository as Record<string, unknown>;
  const flags: Record<MergeMethod, unknown> = {
    merge: fields.mergeCommitAllowed,
    squash: fields.squashMergeAllowed,
    rebase: fields.rebaseMergeAllowed,
  };
  if (MERGE_METHOD_ORDER.some((method) => typeof flags[method] !== "boolean")) return null;
  const allowed = MERGE_METHOD_ORDER.filter((method) => flags[method] === true);
  if (allowed.length === 0) return null;
  const preferred = String(fields.viewerDefaultMergeMethod ?? "").toLowerCase();
  return { allowed, defaultMethod: allowed.find((method) => method === preferred) ?? null };
}

export function mergeChoices(settings: MergeSettings | null | undefined): MergeChoices {
  if (!settings || settings.allowed.length === 0) {
    return { primary: "merge", others: MERGE_METHOD_ORDER.filter((method) => method !== "merge"), known: false };
  }
  const primary = settings.defaultMethod && settings.allowed.includes(settings.defaultMethod) ? settings.defaultMethod : settings.allowed[0];
  return { primary, others: settings.allowed.filter((method) => method !== primary), known: true };
}

export function mergeConfirmText(method: MergeMethod, number: number, base: string): string {
  return `${MERGE_METHOD_LABEL[method]} #${number} into ${base}? This happens on GitHub right away.`;
}
