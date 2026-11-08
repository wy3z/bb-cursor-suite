import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sharedDir, sharedName } from "./versions.mjs";

export const root = resolve(import.meta.dirname, "..");
export const vendorDir = "vendor/bb-suite";

export function git(args, options = {}) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"], ...options }).trim();
}

export function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function blob(text) {
  return git(["hash-object", "-w", "--stdin"], { input: text });
}

export function releaseTree(base, dir) {
  const pkg = JSON.parse(git(["show", `${base}:${dir}/package.json`]));
  if (!pkg.dependencies?.[sharedName]) return { tree: git(["rev-parse", `${base}^{tree}`]), vendored: false };
  const scratch = mkdtempSync(join(tmpdir(), "suite-release-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
  try {
    git(["read-tree", base], { env });
    const files = git(["ls-tree", "-r", base, "--", sharedDir]).split("\n").filter(Boolean);
    for (const line of files) {
      const [meta, path] = line.split("\t");
      const [mode, , object] = meta.split(" ");
      const rel = path.slice(sharedDir.length + 1);
      if (!(rel.startsWith("src/") || rel === "tokens.css" || rel === "README.md" || rel === "LICENSE")) continue;
      git(["update-index", "--add", "--cacheinfo", `${mode},${object},${dir}/${vendorDir}/${rel}`], { env });
    }
    const sharedPkg = JSON.parse(git(["show", `${base}:${sharedDir}/package.json`]));
    delete sharedPkg.devDependencies;
    delete sharedPkg.scripts;
    git(["update-index", "--add", "--cacheinfo", `100644,${blob(json(sharedPkg))},${dir}/${vendorDir}/package.json`], { env });
    const vendored = { ...pkg, dependencies: { ...pkg.dependencies, [sharedName]: `file:./${vendorDir}` } };
    if (vendored.devDependencies?.[sharedName] !== undefined) {
      vendored.devDependencies = { ...vendored.devDependencies };
      delete vendored.devDependencies[sharedName];
    }
    if (Array.isArray(vendored.files) && !vendored.files.includes("vendor")) vendored.files = [...vendored.files, "vendor"];
    git(["update-index", "--add", "--cacheinfo", `100644,${blob(json(vendored))},${dir}/package.json`], { env });
    return { tree: git(["write-tree"], { env }), vendored: true };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
