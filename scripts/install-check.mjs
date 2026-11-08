import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git, releaseTree, root } from "./release-tree.mjs";
import { legacyStreams } from "./versions.mjs";

function usage(code) {
  console.log("Usage: node scripts/install-check.mjs <plugin-id> [--ref <tag-or-commit>] [--legacy] [--keep]");
  console.log("  Without --ref, builds the release layout release.mjs would tag from HEAD.");
  console.log("  With --ref, installs that commit as it is, for a tag that already carries the vendored layout.");
  console.log("  --legacy installs the plugin folder as a repository root, like the legacy vX.Y.Z streams.");
  process.exit(code);
}

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

const argv = process.argv.slice(2);
let id;
let ref;
let legacyLayout = false;
let keep = false;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--ref") ref = argv[++i];
  else if (arg === "--legacy") legacyLayout = true;
  else if (arg === "--keep") keep = true;
  else if (arg === "--help" || arg === "-h") usage(0);
  else if (arg.startsWith("-") || id) usage(1);
  else id = arg;
}
if (!id || (argv.includes("--ref") && !ref)) usage(1);

const entry = JSON.parse(readFileSync(join(root, ".bb/plugins.json"), "utf8")).plugins.find((plugin) => plugin.name === id);
if (!entry) {
  console.error(`No plugin ${id} in .bb/plugins.json`);
  process.exit(1);
}
if (legacyLayout && !legacyStreams[id]) {
  console.error(`${id} has no legacy stream.`);
  process.exit(1);
}
const dir = entry.source.replace(/^\.\//, "");

let tree;
if (ref) {
  tree = git(["rev-parse", `${ref}^{tree}`]);
} else {
  const built = releaseTree(git(["rev-parse", "HEAD"]), dir);
  tree = built.tree;
  console.log(`Release layout for ${id} from HEAD${built.vendored ? " with @wy3z/bb-suite vendored" : ""}: ${tree.slice(0, 12)}`);
}
if (legacyLayout) tree = git(["rev-parse", `${tree}:${dir}`]);

const scratch = mkdtempSync(join(tmpdir(), `install-check-${id}-`));
const checkout = join(scratch, "repo");
const pluginDir = legacyLayout ? checkout : join(checkout, dir);
let failed = false;
try {
  mkdirSync(checkout, { recursive: true });
  execFileSync("sh", ["-c", 'git -C "$1" archive --format=tar "$2" | tar -x -C "$3"', "sh", root, tree, checkout], { stdio: ["ignore", "inherit", "inherit"] });
  for (const base of new Set([checkout, pluginDir])) {
    for (const name of [".npmrc", ".yarnrc", ".yarnrc.yml"]) rmSync(join(base, name), { force: true });
  }

  const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
  const escapes = Object.entries(pkg.dependencies ?? {}).filter(([, spec]) => /^(file|link):(?!\.\/)/.test(spec) || /^(file|link):\.\/\.\./.test(spec));
  if (escapes.length) throw new Error(`dependencies point outside the plugin: ${escapes.map(([name, spec]) => `${name}@${spec}`).join(", ")}`);

  const [npmBin, npmArgs] = bbNpm();
  run(npmBin, [...npmArgs, "install", "--prefix", pluginDir, "--ignore-scripts", "--omit=dev", "--omit=optional", "--no-audit", "--no-fund"], checkout);
  run("bb", ["plugin", "build", pluginDir], checkout);

  const wanted = [["server", "server.js"], ["app", "app.js"], ["host", "host.js"]].filter(([field]) => pkg.bb?.[field]);
  const missing = wanted.map(([, file]) => join("dist", file)).filter((file) => !existsSync(join(pluginDir, file)));
  if (missing.length) throw new Error(`bb plugin build did not produce ${missing.join(", ")}`);
  console.log(`\n${id}${legacyLayout ? " (legacy layout)" : ""} ${pkg.version}: installed and built (${wanted.map(([field]) => field).join(", ")})`);
} catch (error) {
  failed = true;
  console.error(`\n${id}${legacyLayout ? " (legacy layout)" : ""}: install check failed: ${error.message}`);
} finally {
  if (keep) console.log(`Kept ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
