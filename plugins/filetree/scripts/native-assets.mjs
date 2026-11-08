import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
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
const reproduciblePlatforms = ["linux-arm64", "linux-x64"];
const repository = process.env.GITHUB_REPOSITORY ?? "wy3z/bb-cursor-suite";

export async function nativeSourceDigest() {
  let listed;
  try {
    listed = execFileSync("git", ["ls-files", "-z", "--", "host/native"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `Hashing the native source needs git and a checkout of the repository: ${error instanceof Error ? error.message : error}`,
    );
  }
  const names = listed
    .split("\0")
    .filter(Boolean)
    .map((path) => path.slice("host/native/".length))
    .sort();
  if (names.length === 0) throw new Error("git tracks no files under host/native");
  const hash = createHash("sha256");
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

async function writeAssets(assets, target = assetsPath) {
  const sorted = Object.fromEntries(
    Object.keys(assets)
      .sort()
      .map((key) => [key, assets[key]]),
  );
  if (Object.keys(sorted).length === 0)
    throw new Error("No supported native addon prebuild is available");
  await writeFile(
    target,
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

async function verifyCommitted(source) {
  const committed = await readCommitted();
  const prebuilt = await readPrebuilds();
  const scratch = await mkdtemp(join(tmpdir(), "files-native-verify-"));
  const failures = [];
  try {
    for (const platform of platforms) {
      const asset = committed[platform];
      if (!asset) {
        failures.push(`${platform}: no committed build`);
        continue;
      }
      const bytes = Buffer.from(asset.base64, "base64");
      if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
        failures.push(`${platform}: sha256 does not match the embedded bytes`);
        continue;
      }
      const file = join(scratch, `${platform}.node`);
      await writeFile(file, bytes);
      const verified = spawnSync(
        "gh",
        [
          "attestation",
          "verify",
          file,
          "--repo",
          repository,
          "--signer-workflow",
          `${repository}/.github/workflows/files-native.yml`,
          "--deny-self-hosted-runners",
        ],
        { encoding: "utf8" },
      );
      if (verified.status !== 0) {
        failures.push(
          `${platform}: ${asset.sha256} has no provenance attestation from files-native.yml (${(verified.stderr || verified.stdout || "").trim().split("\n")[0]})`,
        );
        continue;
      }
      console.log(`${platform}: ${asset.sha256} attested by files-native.yml`);
      if (
        reproduciblePlatforms.includes(platform) &&
        asset.source === source &&
        prebuilt[platform]?.source === source
      ) {
        if (prebuilt[platform].sha256 !== asset.sha256)
          failures.push(
            `${platform}: committed build ${asset.sha256} differs from this run's reproducible build ${prebuilt[platform].sha256}`,
          );
        else console.log(`${platform}: byte-identical to this run's build`);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  if (failures.length)
    throw new Error(
      `The committed native addons failed verification:\n${failures.join("\n")}`,
    );
}

export async function generateNativeAssets(mode = "default", out = assetsPath) {
  const source = await nativeSourceDigest();
  if (mode === "verify") {
    await verifyCommitted(source);
    return;
  }
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
    await writeAssets(assets, out);
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
  const [flag, out] = process.argv.slice(2);
  const modes = {
    "--check": "check",
    "--prebuilt": "prebuilt",
    "--native": "native",
    "--verify": "verify",
  };
  if (flag !== undefined && !(flag in modes)) {
    console.error(
      "Usage: node scripts/native-assets.mjs [--native | --prebuilt [out] | --check | --verify]",
    );
    process.exit(1);
  }
  try {
    await generateNativeAssets(
      flag ? modes[flag] : "default",
      out ? resolve(out) : assetsPath,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
