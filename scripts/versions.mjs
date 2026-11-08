import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const suiteUrl = "https://github.com/wy3z/bb-cursor-suite.git";
export const sharedDir = "packages/suite-shared";
export const sharedName = "@wy3z/bb-suite";
export const legacyStreams = {
  "cursor-sidebar": "^0.3.2",
  "ui-tweaks": "^0.30.0",
};

const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(text) {
  const match = versionPattern.exec(String(text ?? ""));
  if (!match) return null;
  return { major: +match[1], minor: +match[2], patch: +match[3], pre: match[4] ?? "" };
}

function comparePre(a, b) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === undefined) return -1;
    if (right[i] === undefined) return 1;
    const ln = /^\d+$/.test(left[i]);
    const rn = /^\d+$/.test(right[i]);
    if (ln && rn && +left[i] !== +right[i]) return +left[i] - +right[i];
    if (ln !== rn) return ln ? -1 : 1;
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

export function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || comparePre(a.pre, b.pre);
}

export function parseCaret(range) {
  if (!String(range ?? "").startsWith("^")) return null;
  return parseVersion(range.slice(1));
}

export function satisfiesCaret(versionText, range) {
  const version = parseVersion(versionText);
  const low = parseCaret(range);
  if (!version || !low) return false;
  if (compareVersions(version, low) < 0) return false;
  if (version.pre && !(version.major === low.major && version.minor === low.minor && version.patch === low.patch && low.pre)) return false;
  if (low.major > 0) return version.major === low.major;
  if (low.minor > 0) return version.major === 0 && version.minor === low.minor;
  return version.major === 0 && version.minor === 0 && version.patch === low.patch;
}

function readJson(root, path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function readmeRanges(root) {
  const ranges = new Map();
  const text = readFileSync(join(root, "README.md"), "utf8");
  const pattern = /bb plugin install git:(\S+?)@(\S+) --plugin (\S+) --tag-prefix (\S+)/g;
  for (const match of text.matchAll(pattern)) ranges.set(match[3], { url: match[1], range: match[2], tagPrefix: match[4] });
  return ranges;
}

export function checkVersions(root, overrides = {}) {
  const errors = [];
  const plugins = readJson(root, ".bb/plugins.json").plugins.map((entry) => ({ id: entry.name, dir: entry.source.replace(/^\.\//, "") }));
  const marketplace = readJson(root, "marketplace/marketplace.json").plugins;
  const readme = readmeRanges(root);
  const lock = readJson(root, "package-lock.json").packages ?? {};
  const shared = readJson(root, join(sharedDir, "package.json"));

  const sharedVersion = parseVersion(shared.version);
  if (!sharedVersion) errors.push(`${sharedDir}: version ${shared.version} is not x.y.z`);
  else if (sharedVersion.major < 1) errors.push(`${sharedDir}: version ${shared.version} is below 1.0.0`);
  if (lock[sharedDir] && lock[sharedDir].version !== shared.version) {
    errors.push(`package-lock.json: ${sharedDir} is ${lock[sharedDir].version}, package.json says ${shared.version}; run npm install`);
  }

  for (const entry of marketplace) {
    if (!plugins.some((plugin) => plugin.id === entry.id)) errors.push(`marketplace.json: ${entry.id} is not in .bb/plugins.json`);
  }
  for (const id of readme.keys()) {
    if (!plugins.some((plugin) => plugin.id === id)) errors.push(`README.md: install line for ${id}, which is not in .bb/plugins.json`);
  }
  for (const id of Object.keys(overrides)) {
    if (!plugins.some((plugin) => plugin.id === id)) errors.push(`${id} is not in .bb/plugins.json`);
  }

  for (const { id, dir } of plugins) {
    const pkg = readJson(root, join(dir, "package.json"));
    const version = overrides[id] ?? pkg.version;
    const parsed = parseVersion(version);
    if (!parsed) {
      errors.push(`${id}: version ${version} is not x.y.z`);
      continue;
    }
    if (lock[dir] && lock[dir].version !== pkg.version) {
      errors.push(`package-lock.json: ${dir} is ${lock[dir].version}, package.json says ${pkg.version}; run npm install`);
    }

    const stream = legacyStreams[id];
    if (stream && !satisfiesCaret(version, stream)) {
      errors.push(`${id}: ${version} leaves the legacy ${stream} stream, so existing installs would never see it. End the stream on purpose by removing ${id} from legacyStreams in scripts/versions.mjs.`);
    }
    if (!stream && parsed.major < 1) errors.push(`${id}: ${version} is below 1.0.0; 0.x caret ranges lock users to one minor`);

    const listing = marketplace.find((item) => item.id === id);
    const git = listing?.source?.git;
    if (!git) {
      errors.push(`marketplace.json: no git source for ${id}`);
    } else {
      if (git.url !== suiteUrl) errors.push(`marketplace.json: ${id} url is ${git.url}, expected ${suiteUrl}`);
      if (git.subdir !== dir) errors.push(`marketplace.json: ${id} subdir is ${git.subdir}, expected ${dir}`);
      if (git.tagPrefix !== `${id}/`) errors.push(`marketplace.json: ${id} tagPrefix is ${git.tagPrefix}, expected ${id}/`);
      const low = parseCaret(git.range);
      if (!low || low.pre) errors.push(`marketplace.json: ${id} range ${git.range} is not ^x.y.z`);
      else if (!satisfiesCaret(version, git.range)) errors.push(`marketplace.json: ${id} range ${git.range} would never offer ${version}`);
      else if (stream && !satisfiesCaret(`${low.major}.${low.minor}.${low.patch}`, stream)) errors.push(`marketplace.json: ${id} range ${git.range} is outside the legacy ${stream} stream`);
    }

    const line = readme.get(id);
    if (!line) {
      errors.push(`README.md: no install line for ${id}`);
    } else {
      if (line.url !== suiteUrl) errors.push(`README.md: ${id} installs from ${line.url}, expected ${suiteUrl}`);
      if (line.tagPrefix !== `${id}/`) errors.push(`README.md: ${id} tag prefix is ${line.tagPrefix}, expected ${id}/`);
      if (git && line.range !== git.range) errors.push(`README.md: ${id} range ${line.range} differs from marketplace.json ${git.range}`);
    }

    const sharedRange = pkg.dependencies?.[sharedName] ?? pkg.devDependencies?.[sharedName];
    if (sharedRange !== undefined) {
      if (!parseCaret(sharedRange)) errors.push(`${id}: ${sharedName} is ${sharedRange}, expected a ^x.y.z range`);
      else if (!satisfiesCaret(shared.version, sharedRange)) errors.push(`${id}: ${sharedName} ${sharedRange} does not match ${sharedDir} ${shared.version}, so npm would look for it on the registry`);
    }
  }
  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = resolve(import.meta.dirname, "..");
  const errors = checkVersions(root);
  if (errors.length) {
    console.error("Versions and ranges are inconsistent:");
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }
  console.log("Versions and ranges are consistent.");
}
