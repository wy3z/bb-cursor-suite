import { describe, expect, it } from "vitest";
import { MERGE_METHOD_LABEL, mergeChoices, mergeConfirmText, mergeSettingsFrom } from "./merge-method";

function repo(overrides: Record<string, unknown> = {}) {
  return {
    mergeCommitAllowed: true,
    squashMergeAllowed: true,
    rebaseMergeAllowed: true,
    viewerDefaultMergeMethod: "MERGE",
    ...overrides,
  };
}

describe("reading a repository's merge settings", () => {
  it("keeps every allowed method in GitHub's order and the viewer's default", () => {
    expect(mergeSettingsFrom(repo({ viewerDefaultMergeMethod: "REBASE" }))).toEqual({
      allowed: ["merge", "squash", "rebase"],
      defaultMethod: "rebase",
    });
  });

  it("drops methods the repository disallows", () => {
    expect(mergeSettingsFrom(repo({ squashMergeAllowed: false, viewerDefaultMergeMethod: "MERGE" }))).toEqual({
      allowed: ["merge", "rebase"],
      defaultMethod: "merge",
    });
  });

  it("ignores a default that the repository does not allow", () => {
    expect(mergeSettingsFrom(repo({ mergeCommitAllowed: false, viewerDefaultMergeMethod: "MERGE" }))).toEqual({
      allowed: ["squash", "rebase"],
      defaultMethod: null,
    });
  });

  it("returns null when the answer is missing or malformed", () => {
    expect(mergeSettingsFrom(null)).toBeNull();
    expect(mergeSettingsFrom("repo")).toBeNull();
    expect(mergeSettingsFrom(repo({ rebaseMergeAllowed: undefined }))).toBeNull();
    expect(mergeSettingsFrom(repo({ mergeCommitAllowed: false, squashMergeAllowed: false, rebaseMergeAllowed: false }))).toBeNull();
  });
});

describe("choosing the merge button", () => {
  it("uses the repository default as the primary and offers the other allowed methods", () => {
    expect(mergeChoices({ allowed: ["merge", "squash", "rebase"], defaultMethod: "rebase" })).toEqual({
      primary: "rebase",
      others: ["merge", "squash"],
      known: true,
    });
  });

  it("uses a merge commit when the repository defaults to it", () => {
    expect(mergeChoices({ allowed: ["merge", "squash"], defaultMethod: "merge" })).toEqual({
      primary: "merge",
      others: ["squash"],
      known: true,
    });
  });

  it("squashes only when squash is the repository default", () => {
    expect(mergeChoices({ allowed: ["merge", "squash", "rebase"], defaultMethod: "squash" }).primary).toBe("squash");
    expect(mergeChoices({ allowed: ["merge", "squash", "rebase"], defaultMethod: "merge" }).primary).not.toBe("squash");
  });

  it("falls back to the first allowed method without a usable default", () => {
    expect(mergeChoices({ allowed: ["squash", "rebase"], defaultMethod: null })).toEqual({
      primary: "squash",
      others: ["rebase"],
      known: true,
    });
    expect(mergeChoices({ allowed: ["rebase"], defaultMethod: null })).toEqual({ primary: "rebase", others: [], known: true });
  });

  it("never forces squash when the settings could not be read", () => {
    for (const settings of [null, undefined, { allowed: [], defaultMethod: null }]) {
      expect(mergeChoices(settings)).toEqual({ primary: "merge", others: ["squash", "rebase"], known: false });
    }
  });

  it("labels each method the way GitHub does", () => {
    expect(MERGE_METHOD_LABEL).toEqual({ merge: "Merge", squash: "Squash and merge", rebase: "Rebase and merge" });
  });

  it("names the method and target in the confirmation", () => {
    expect(mergeConfirmText("rebase", 12, "main")).toBe("Rebase and merge #12 into main? This happens on GitHub right away.");
    expect(mergeConfirmText("merge", 7, "develop")).toBe("Merge #7 into develop? This happens on GitHub right away.");
  });
});
