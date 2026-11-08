import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const nativeDir = join(root, "host/native");
const prebuildDir = join(root, "prebuilds");
const assetsPath = join(root, "generated/native-assets.ts");

export const platforms = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
];
export const currentPlatform = `${process.platform}-${process.arch}`;

export async function nativeSourceDigest() {
  const hash = createHash("sha256");
  const entries = await readdir(nativeDir, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const text = (await readFile(join(nativeDir, name), "utf8")).replace(
      /\r\n/g,
      "\n",
    );
    hash.update(`${name}\0${text}\0`);
  }
  return hash.digest("hex");
}

function entry(bytes, source) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    source,
    base64: bytes.toString("base64"),
  };
}

async function readCommitted() {
  if (!existsSync(assetsPath)) return {};
  const text = await readFile(assetsPath, "utf8");
  const match = /= (\{[\s\S]*\});\s*$/u.exec(text);
  return match ? JSON.parse(match[1]) : {};
}

async function readPrebuilds() {
  const assets = {};
  if (!existsSync(prebuildDir)) return assets;
  for (const platform of platforms) {
    const binary = join(prebuildDir, `${platform}.node`);
    const meta = join(prebuildDir, `${platform}.json`);
    if (!existsSync(binary) || !existsSync(meta)) continue;
    const { source } = JSON.parse(await readFile(meta, "utf8"));
    assets[platform] = entry(await readFile(binary), source);
  }
  return assets;
}

async function writeAssets(assets) {
  const sorted = Object.fromEntries(
    Object.keys(assets)
      .sort()
      .map((key) => [key, assets[key]]),
  );
  if (Object.keys(sorted).length === 0)
    throw new Error("No supported native addon prebuild is available");
  await mkdir(join(root, "generated"), { recursive: true });
  await writeFile(
    assetsPath,
    `export const nativeAssets: Readonly<Record<string, { sha256: string; source: string; base64: string }>> = ${JSON.stringify(sorted)};\n`,
  );
}

async function buildCurrent(source) {
  if (!platforms.includes(currentPlatform))
    throw new Error(`Files has no native addon target for ${currentPlatform}`);
  const require = createRequire(import.meta.url);
  const args = [
    require.resolve("node-gyp/bin/node-gyp.js"),
    "rebuild",
    "--release",
  ];
  if (existsSync("/usr/include/node/node.h")) args.push("--nodedir=/usr");
  const result = spawnSync(process.execPath, args, {
    cwd: nativeDir,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("Files native addon build failed");
  const bytes = await readFile(
    join(nativeDir, "build/Release/host_native_files.node"),
  );
  await mkdir(prebuildDir, { recursive: true });
  await writeFile(join(prebuildDir, `${currentPlatform}.node`), bytes);
  await writeFile(
    join(prebuildDir, `${currentPlatform}.json`),
    `${JSON.stringify({ source })}\n`,
  );
  return entry(bytes, source);
}

function stale(assets, source) {
  const missing = platforms.filter((platform) => !assets[platform]);
  const outdated = platforms.filter(
    (platform) => assets[platform] && assets[platform].source !== source,
  );
  return { missing, outdated };
}

export async function generateNativeAssets(mode = "default") {
  const source = await nativeSourceDigest();
  if (mode === "check") {
    const { missing, outdated } = stale(await readCommitted(), source);
    if (missing.length === 0 && outdated.length === 0) {
      console.log(`OK: native addons for ${platforms.join(", ")} match the C source`);
      return;
    }
    const problems = [
      missing.length ? `missing ${missing.join(", ")}` : null,
      outdated.length ? `built from older C source: ${outdated.join(", ")}` : null,
    ].filter(Boolean);
    throw new Error(
      `generated/native-assets.ts is not release-ready (${problems.join("; ")}). Run the "Files native addon" workflow and import its files-native-assets artifact; see docs/development.md.`,
    );
  }
  if (mode === "prebuilt") {
    const assets = await readPrebuilds();
    const { missing, outdated } = stale(assets, source);
    if (missing.length || outdated.length)
      throw new Error(
        `Prebuilds are incomplete: missing [${missing.join(", ")}], stale [${outdated.join(", ")}]`,
      );
    await writeAssets(assets);
    return;
  }
  const assets = await readCommitted();
  for (const [platform, value] of Object.entries(await readPrebuilds())) {
    if (assets[platform]?.source !== source && value.source === source)
      assets[platform] = value;
  }
  if (
    mode === "native" ||
    (platforms.includes(currentPlatform) &&
      assets[currentPlatform]?.source !== source)
  )
    assets[currentPlatform] = await buildCurrent(source);
  await writeAssets(assets);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv[2];
  const modes = { "--check": "check", "--prebuilt": "prebuilt", "--native": "native" };
  if (flag !== undefined && !(flag in modes)) {
    console.error("Usage: node scripts/native-assets.mjs [--native | --prebuilt | --check]");
    process.exit(1);
  }
  try {
    await generateNativeAssets(flag ? modes[flag] : "default");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
