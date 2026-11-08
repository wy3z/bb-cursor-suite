import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installCheck } from "./install-check.mjs";
import { git, json, releaseTree, root } from "./release-tree.mjs";
import { checkVersions, compareVersions, parseVersion } from "./versions.mjs";

const legacy = {
  "cursor-sidebar": { branch: "legacy/cursor-sidebar", remote: "origin", remoteBranch: "legacy/cursor-sidebar" },
  "ui-tweaks": { branch: "legacy/ui-tweaks", remote: "ui-tweaks-mirror", remoteBranch: "main" },
};

function usage(code) {
  console.log("Usage: npm run release -- <plugin-id> <x.y.z> [--push] [--no-legacy]");
  process.exit(code);
}

function remoteVersions(remote, pattern, prefix) {
  let out;
  try {
    out = git(["ls-remote", "--tags", remote, pattern]);
  } catch {
    console.error(`Could not list tags on ${remote}; refusing to release without checking what is published.`);
    process.exit(1);
  }
  const versions = new Set();
  for (const line of out.split("\n").filter(Boolean)) {
    const ref = line.split("\t")[1].replace(/\^\{\}$/, "");
    const name = ref.slice("refs/tags/".length);
    if (name.startsWith(prefix) && parseVersion(name.slice(prefix.length))) versions.add(name.slice(prefix.length));
  }
  return [...versions];
}

function refuseIfPublished(remote, pattern, prefix, label) {
  const newer = remoteVersions(remote, pattern, prefix).filter((published) => compareVersions(parseVersion(published), parseVersion(version)) >= 0);
  if (newer.length) {
    console.error(`${label} on ${remote} already has ${newer.map((v) => `${prefix}${v}`).join(", ")}; ${version} must be higher than every published version.`);
    process.exit(1);
  }
}

function refExists(ref) {
  try {
    git(["rev-parse", "--verify", "--quiet", ref], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
const [id, version] = argv.filter((arg) => !arg.startsWith("--"));
if (!id || !version) usage(1);
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) usage(1);
for (const flag of flags) if (!["--push", "--no-legacy"].includes(flag)) usage(1);

const index = JSON.parse(readFileSync(join(root, ".bb/plugins.json"), "utf8"));
const entry = index.plugins.find((plugin) => plugin.name === id);
if (!entry) {
  console.error(`No plugin ${id} in .bb/plugins.json`);
  process.exit(1);
}
const dir = entry.source.replace(/^\.\//, "");
const tag = `${id}/v${version}`;
if (refExists(`refs/tags/${tag}`)) {
  console.error(`Tag ${tag} already exists. Publish a new version instead of moving a tag.`);
  process.exit(1);
}
if (git(["status", "--porcelain"])) {
  console.error("Working tree is not clean.");
  process.exit(1);
}
const problems = checkVersions(root, { [id]: version });
if (problems.length) {
  console.error(`Refusing to release ${id} v${version}; versions and ranges are inconsistent:`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") console.warn(`Releasing from ${branch}, not main.`);

const pkgPath = join(root, dir, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
if (compareVersions(parseVersion(version), parseVersion(pkg.version)) < 0) {
  console.error(`Refusing to downgrade ${id} from ${pkg.version} to ${version}.`);
  process.exit(1);
}
refuseIfPublished("origin", `refs/tags/${id}/v*`, `${id}/v`, `${id}`);
const stream = legacy[id];
const pushLegacy = Boolean(stream) && !flags.has("--no-legacy");
if (pushLegacy) refuseIfPublished(stream.remote, "refs/tags/v*", "v", `The ${id} legacy stream`);

const startHead = git(["rev-parse", "HEAD"]);
let bumped = false;
if (pkg.version !== version) {
  pkg.version = version;
  writeFileSync(pkgPath, json(pkg));
  const lockPath = join(root, "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (lock.packages?.[dir]) {
    lock.packages[dir].version = version;
    writeFileSync(lockPath, json(lock));
  }
  git(["add", join(dir, "package.json"), "package-lock.json"]);
  git(["commit", "-q", "-m", `Release ${id} v${version}`]);
  bumped = true;
}
const base = git(["rev-parse", "HEAD"]);

const built = releaseTree(base, dir);
const release = built.vendored
  ? git(["commit-tree", built.tree, "-p", base, "-m", `Release ${id} v${version} with @wy3z/bb-suite vendored\n\nSource: ${base}`])
  : base;
const layouts = pushLegacy ? [false, true] : [false];
for (const layout of layouts) {
  if (!installCheck({ id, dir, tree: built.tree, legacy: layout }).ok) {
    if (bumped) {
      git(["reset", "-q", "--keep", startHead]);
      console.error(`Dropped the local version bump commit; ${branch} is back at ${startHead.slice(0, 12)}.`);
    }
    console.error(`Refusing to tag ${tag}: the release layout does not install.`);
    process.exit(1);
  }
}
git(["tag", "-a", tag, release, "-m", `${id} v${version}`]);
const pushes = [["origin", `refs/heads/${branch}`], ["origin", `refs/tags/${tag}`]];
console.log(`Tagged ${tag} at ${release.slice(0, 12)}${release === base ? "" : ` (vendored, source ${base.slice(0, 12)})`}`);

if (pushLegacy) {
  const legacyTag = `v${version}`;
  if (stream.remote !== "origin" && refExists(`refs/tags/${legacyTag}`)) {
    console.error(`Tag ${legacyTag} exists locally; it would clash with the ${stream.remote} stream.`);
    process.exit(1);
  }
  if (!refExists(`refs/heads/${stream.branch}`)) {
    console.error(`Branch ${stream.branch} is missing; create it from the last root-level commit of the old repository.`);
    process.exit(1);
  }
  const parent = git(["rev-parse", stream.branch]);
  const tree = git(["rev-parse", `${release}:${dir}`]);
  const commit = git(["commit-tree", tree, "-p", parent, "-m", `${id} v${version}\n\nSplit from ${release} (${dir})`]);
  git(["update-ref", `refs/heads/${stream.branch}`, commit, parent]);
  if (stream.remote === "origin") {
    git(["tag", "-a", legacyTag, commit, "-m", `${id} v${version} (legacy root-level stream)`]);
    pushes.push(["origin", `refs/heads/${stream.branch}:refs/heads/${stream.remoteBranch}`], ["origin", `refs/tags/${legacyTag}`]);
  } else {
    const mirrorTag = `refs/tags/${stream.remote}/${legacyTag}`;
    git(["tag", "-a", `${stream.remote}/${legacyTag}`, commit, "-m", `${id} v${version} (mirror)`]);
    pushes.push([stream.remote, `refs/heads/${stream.branch}:refs/heads/${stream.remoteBranch}`], [stream.remote, `${mirrorTag}:refs/tags/${legacyTag}`]);
  }
  console.log(`Legacy ${stream.branch} -> ${commit.slice(0, 12)}, tag v${version}`);
}

const pushCommands = pushes.map(([remote, refspec]) => ["git", "push", remote, refspec]);
if (flags.has("--push")) {
  for (const [, ...args] of pushCommands) git(args, { stdio: "inherit" });
} else {
  console.log("\nNothing pushed. To publish:");
  for (const cmd of pushCommands) console.log(`  ${cmd.join(" ")}`);
}
