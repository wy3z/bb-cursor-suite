import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git, gitRun } from "./release-tree.mjs";

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "suite-release-push-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function repository(t) {
  const dir = scratch(t);
  git(["init", "-q"], { cwd: dir });
  git(["config", "user.email", "release@example.invalid"], { cwd: dir });
  git(["config", "user.name", "Release Test"], { cwd: dir });
  git(["config", "commit.gpgsign", "false"], { cwd: dir });
  git(["config", "tag.gpgsign", "false"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "release\n");
  git(["add", "README.md"], { cwd: dir });
  git(["commit", "-q", "-m", "Initial"], { cwd: dir });
  return dir;
}

test("git returns an empty string when stdout is inherited", (t) => {
  const dir = repository(t);
  assert.equal(git(["status", "--porcelain"], { cwd: dir, stdio: ["ignore", "inherit", "inherit"] }), "");
});

test("git still trims piped output", (t) => {
  const dir = repository(t);
  assert.equal(git(["rev-parse", "--is-inside-work-tree"], { cwd: dir }), "true");
});

test("gitRun pushes every ref it is given", (t) => {
  const dir = repository(t);
  const remote = join(scratch(t), "remote.git");
  execFileSync("git", ["init", "--bare", "-q", remote]);
  git(["remote", "add", "origin", remote], { cwd: dir });
  git(["branch", "release/one"], { cwd: dir });
  git(["branch", "release/two"], { cwd: dir });
  for (const ref of ["release/one", "release/two"]) gitRun(["push", "origin", `refs/heads/${ref}`], { cwd: dir });
  const pushed = execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/heads"], { cwd: remote, encoding: "utf8" });
  assert.deepEqual(pushed.trim().split("\n").sort(), ["refs/heads/release/one", "refs/heads/release/two"]);
});
