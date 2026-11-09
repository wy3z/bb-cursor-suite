import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const suiteUrl = "https://github.com/wy3z/bb-cursor-suite.git";
export const sharedDir = "packages/suite-shared";
export const sharedName = "@wy3z/bb-suite";
export const sharedSpec = `file:../../${sharedDir}`;
export const previewPlugins = new Set(["machine-boat"]);
export const legacyStreams = {
  "cursor-sidebar": "^0.3.2",
  "ui-tweaks": "^0.30.0",
};

export function isMainModule(url) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

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

export function sharedSpecErrors(pkg, expected) {
  const errors = [];
  for (const field of ["peerDependencies", "optionalDependencies"]) {
    if (pkg[field]?.[sharedName] !== undefined) errors.push(`${sharedName} is in ${field}; npm would fetch it from the registry`);
  }
  for (const field of ["bundleDependencies", "bundledDependencies"]) {
    const bundled = pkg[field];
    if (bundled === true || (Array.isArray(bundled) && bundled.includes(sharedName))) errors.push(`${sharedName} is bundled through ${field}`);
  }
  if (pkg.devDependencies?.[sharedName] !== undefined && pkg.dependencies?.[sharedName] === undefined) {
    errors.push(`${sharedName} is only in devDependencies; it must be in dependencies so releases vendor it`);
  }
  for (const field of ["dependencies", "devDependencies"]) {
    const spec = pkg[field]?.[sharedName];
    if (spec !== undefined && spec !== expected) errors.push(`${sharedName} in ${field} is ${spec}, expected exactly ${expected}`);
  }
  return errors;
}

function readJson(root, path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

export const marketplaceAddLine = "bb marketplace add git:github.com/wy3z/bb-cursor-suite@main --subdirectory marketplace";

function readmeLines(root, path) {
  const text = readFileSync(join(root, path), "utf8");
  const installs = [];
  for (const match of text.matchAll(/bb plugin install git:(\S*github\.com\/\S*)([^\n`]*)/g)) {
    const at = match[1].indexOf("@");
    installs.push({
      url: at === -1 ? match[1] : match[1].slice(0, at),
      range: at === -1 ? undefined : match[1].slice(at + 1),
      id: /--plugin (\S+)/.exec(match[2])?.[1],
      tagPrefix: /--tag-prefix (\S+)/.exec(match[2])?.[1],
    });
  }
  const adds = [...text.matchAll(/bb marketplace add [^\n`]*/g)].map((match) => match[0].trim());
  return { installs, adds };
}

function checkReadme(root, path, required, plugins, ranges, errors) {
  if (!existsSync(join(root, path))) {
    errors.push(`${path}: missing`);
    return;
  }
  const { installs, adds } = readmeLines(root, path);
  if (!adds.length) errors.push(`${path}: no marketplace add line`);
  for (const add of adds) if (add !== marketplaceAddLine) errors.push(`${path}: marketplace add line is "${add}", expected "${marketplaceAddLine}"`);
  for (const line of installs) {
    const label = `${path}: install line for ${line.id ?? "an unnamed plugin"}`;
    if (!line.id) {
      errors.push(`${label} has no --plugin`);
      continue;
    }
    if (!plugins.some((plugin) => plugin.id === line.id)) errors.push(`${label}, which is not in .bb/plugins.json`);
    if (line.url !== suiteUrl) errors.push(`${label} installs from ${line.url}, expected ${suiteUrl}`);
    if (line.tagPrefix !== `${line.id}/`) errors.push(`${label} has tag prefix ${line.tagPrefix ?? "(none)"}, expected ${line.id}/`);
    const range = ranges.get(line.id);
    if (!line.range) errors.push(`${label} has no range, so it would track the default branch`);
    else if (range && line.range !== range) errors.push(`${label} uses ${line.range}, marketplace.json says ${range}`);
  }
  for (const id of required) if (!installs.some((line) => line.id === id)) errors.push(`${path}: no install line for ${id}`);
}

export function checkVersions(root, overrides = {}) {
  const errors = [];
  const plugins = readJson(root, ".bb/plugins.json").plugins.map((entry) => ({ id: entry.name, dir: entry.source.replace(/^\.\//, "") }));
  const marketplace = readJson(root, "marketplace/marketplace.json").plugins;
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
  const ranges = new Map(marketplace.map((entry) => [entry.id, entry.source?.git?.range]));
  checkReadme(root, "README.md", plugins.map((plugin) => plugin.id), plugins, ranges, errors);
  for (const { id, dir } of plugins) checkReadme(root, join(dir, "README.md"), [id], plugins, ranges, errors);
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
    if (!stream && !previewPlugins.has(id) && parsed.major < 1) errors.push(`${id}: ${version} is below 1.0.0; 0.x caret ranges lock users to one minor`);

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

    for (const error of sharedSpecErrors(pkg, sharedSpec)) errors.push(`${id}: ${error}`);
  }
  return errors;
}

if (isMainModule(import.meta.url)) {
  const root = resolve(import.meta.dirname, "..");
  const errors = checkVersions(root);
  if (errors.length) {
    console.error("Versions and ranges are inconsistent:");
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }
  console.log("Versions and ranges are consistent.");
}
