const fs = require("fs");
const { execFileSync } = require("child_process");
const { prs } = require("./data.cjs");
const LOCAL = { "acme/web": "acme-web", "acme/api": "acme-api", "acme/orbit": "acme-orbit" };
const repos = process.env.FAKEGH_REPOS || "";
const cachePath = process.env.FAKEGH_CACHE;
const gitOut = (dir, a) => {
  try {
    return execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};
const cache = {};
for (const p of prs) {
  const dir = require("path").join(repos, LOCAL[p.repo] || "x");
  const headRef = "refs/heads/" + p.head;
  const entry = {};
  if (gitOut(dir, ["rev-parse", "--verify", "-q", headRef]) !== null) {
    const sha = (gitOut(dir, ["rev-parse", headRef]) || "").trim();
    if (sha) entry.oid = sha;
    const out = gitOut(dir, ["diff", "--numstat", "main..." + p.head]);
    if (out) {
      const files = out
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [a, d, path] = l.split("\t");
          return [path, Number(a) || 0, Number(d) || 0];
        });
      if (files.length) {
        entry.files = files;
        entry.add = files.reduce((n, x) => n + x[1], 0);
        entry.del = files.reduce((n, x) => n + x[2], 0);
      }
    }
  }
  cache[`${p.repo}#${p.number}`] = entry;
}
if (!cachePath) throw new Error("FAKEGH_CACHE is required");
fs.writeFileSync(cachePath, JSON.stringify(cache) + "\n");
process.stdout.write(Object.keys(cache).length + "\n");
