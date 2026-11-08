import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { git, releaseTree, root, vendorDir } from "./release-tree.mjs";
import { legacyStreams, sharedName, sharedSpecErrors } from "./versions.mjs";

function bbNpm() {
  if (process.env.BB_NPM) return [process.execPath, [process.env.BB_NPM]];
  try {
    const bb = realpathSync(execFileSync("sh", ["-c", "command -v bb"], { encoding: "utf8" }).trim());
    const npmPkg = createRequire(bb).resolve("npm/package.json");
    return [process.execPath, [join(dirname(npmPkg), "bin", "npm-cli.js")]];
  } catch {
    console.warn("Could not find the npm bundled with bb; using npm from PATH.");
    return ["npm", []];
  }
}

function run(bin, args, cwd) {
  console.log(`$ ${[bin, ...args].join(" ")}`);
  const result = spawnSync(bin, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${bin} exited with ${result.status ?? result.signal}`);
}

function inside(child, parent) {
  return child === parent || child.startsWith(parent + sep);
}

export function pluginDirOf(id) {
  const entry = JSON.parse(readFileSync(join(root, ".bb/plugins.json"), "utf8")).plugins.find((plugin) => plugin.name === id);
  return entry ? entry.source.replace(/^\.\//, "") : null;
}

export function installCheck({ id, dir, tree, legacy = false, keep = false }) {
  const label = `${id}${legacy ? " (legacy layout)" : ""}`;
  const scratch = mkdtempSync(join(tmpdir(), `install-check-${id}-`));
  const checkout = join(scratch, "repo");
  const pluginDir = legacy ? checkout : join(checkout, dir);
  try {
    const archived = legacy ? git(["rev-parse", `${tree}:${dir}`]) : tree;
    mkdirSync(checkout, { recursive: true });
    execFileSync("sh", ["-c", 'git -C "$1" archive --format=tar "$2" | tar -x -C "$3"', "sh", root, archived, checkout], { stdio: ["ignore", "inherit", "inherit"] });
    for (const base of new Set([checkout, pluginDir])) {
      for (const name of [".npmrc", ".yarnrc", ".yarnrc.yml"]) rmSync(join(base, name), { force: true });
    }

    const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
    const escapes = Object.entries(pkg.dependencies ?? {}).filter(([, spec]) => /^(file|link):(?!\.\/)/.test(spec) || /^(file|link):\.\/\.\./.test(spec));
    if (escapes.length) throw new Error(`dependencies point outside the plugin: ${escapes.map(([name, spec]) => `${name}@${spec}`).join(", ")}`);
    const placement = sharedSpecErrors(pkg, `file:./${vendorDir}`);
    if (placement.length) throw new Error(placement.join("; "));
    const usesShared = pkg.dependencies?.[sharedName] !== undefined;

    const [npmBin, npmArgs] = bbNpm();
    run(npmBin, [...npmArgs, "install", "--prefix", pluginDir, "--ignore-scripts", "--omit=dev", "--omit=optional", "--no-audit", "--no-fund"], checkout);

    if (usesShared) {
      const installed = join(pluginDir, "node_modules", ...sharedName.split("/"));
      if (!existsSync(installed)) throw new Error(`${sharedName} was not installed`);
      const resolved = realpathSync(installed);
      const vendored = realpathSync(join(pluginDir, vendorDir));
      if (!inside(resolved, vendored)) throw new Error(`${sharedName} resolved to ${resolved}, not the vendored copy in ${vendorDir}`);
    }

    run("bb", ["plugin", "build", pluginDir], checkout);

    const bundles = ["server", ...["app", "host"].filter((field) => pkg.bb?.[field])];
    const problems = [];
    for (const bundle of bundles) {
      const metaPath = join(pluginDir, "dist", `${bundle}.meta.json`);
      if (!existsSync(join(pluginDir, "dist", `${bundle}.js`))) problems.push(`dist/${bundle}.js is missing`);
      if (!existsSync(metaPath)) {
        problems.push(`dist/${bundle}.meta.json is missing`);
        continue;
      }
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      if (meta.pluginId !== id) problems.push(`dist/${bundle}.meta.json pluginId is ${meta.pluginId}, expected ${id}`);
      if (meta.pluginVersion !== pkg.version) problems.push(`dist/${bundle}.meta.json pluginVersion is ${meta.pluginVersion}, expected ${pkg.version}`);
    }
    if (problems.length) throw new Error(problems.join("; "));
    console.log(`\n${label} ${pkg.version}: installed and built (${bundles.join(", ")})`);
    return { ok: true, version: pkg.version };
  } catch (error) {
    console.error(`\n${label}: install check failed: ${error.message}`);
    return { ok: false, error: error.message };
  } finally {
    if (keep) console.log(`Kept ${scratch}`);
    else rmSync(scratch, { recursive: true, force: true });
  }
}

function usage(code) {
  console.log("Usage: node scripts/install-check.mjs <plugin-id> [--ref <tag-or-commit>] [--legacy] [--keep]");
  console.log("  Without --ref, builds the release layout release.mjs would tag from HEAD.");
  console.log("  With --ref, installs that commit as it is, for a tag that already carries the vendored layout.");
  console.log("  --legacy installs the plugin folder as a repository root, like the legacy vX.Y.Z streams.");
  process.exit(code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argv = process.argv.slice(2);
  let id;
  let ref;
  let legacy = false;
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ref") ref = argv[++i];
    else if (arg === "--legacy") legacy = true;
    else if (arg === "--keep") keep = true;
    else if (arg === "--help" || arg === "-h") usage(0);
    else if (arg.startsWith("-") || id) usage(1);
    else id = arg;
  }
  if (!id || (argv.includes("--ref") && !ref)) usage(1);
  const dir = pluginDirOf(id);
  if (!dir) {
    console.error(`No plugin ${id} in .bb/plugins.json`);
    process.exit(1);
  }
  if (legacy && !legacyStreams[id]) {
    console.error(`${id} has no legacy stream.`);
    process.exit(1);
  }
  let tree;
  if (ref) {
    tree = git(["rev-parse", `${ref}^{tree}`]);
  } else {
    const built = releaseTree(git(["rev-parse", "HEAD"]), dir);
    tree = built.tree;
    console.log(`Release layout for ${id} from HEAD${built.vendored ? " with @wy3z/bb-suite vendored" : ""}: ${tree.slice(0, 12)}`);
  }
  process.exit(installCheck({ id, dir, tree, legacy, keep }).ok ? 0 : 1);
}
