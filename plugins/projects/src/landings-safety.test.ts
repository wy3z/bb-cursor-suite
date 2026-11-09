import { afterAll, describe, expect, it } from "bun:test";
import { createHostileRepo, plainGitRunsCode, type HostileRepo, type HostileRepoOptions } from "@wy3z/bb-suite/testing/hostile-git";
import { commitsMentioning } from "./landings";

const repos: HostileRepo[] = [];
const since = new Date(Date.now() - 86_400_000).toISOString();

afterAll(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()));
});

async function hostile(options: HostileRepoOptions = {}): Promise<HostileRepo> {
  const repo = await createHostileRepo(options);
  repos.push(repo);
  return repo;
}

describe("reading landed commits from a hostile checkout", () => {
  it("uses a fixture whose config runs code under plain git log", async () => {
    const repo = await hostile();
    expect(await plainGitRunsCode(repo)).toEqual(expect.arrayContaining(["gpg", "fsmonitor", "clean"]));
  });

  it("reads the commits without running anything", async () => {
    const repo = await hostile();
    const commits = await commitsMentioning(repo.root, "BCS", since, "git@github.com:o/r.git");
    expect(commits.map((commit) => commit.message)).toEqual(["BCS-2 signed", "BCS-1 initial"]);
    expect(commits[0]?.url).toMatch(/^https:\/\/github\.com\/o\/r\/commit\/[0-9a-f]{40}$/u);
    expect(await repo.markers()).toEqual([]);
  });

  it("fetches no missing commit through the repository's transport", async () => {
    const repo = await hostile({ partialClone: true });
    await repo.git(["log", "--format=%H", "origin/main"]).catch(() => "");
    expect(await repo.markers()).toEqual(["fetch"]);
    await repo.clearMarkers();
    await commitsMentioning(repo.root, "BCS", since, null).catch(() => []);
    expect(await repo.markers()).toEqual([]);
  });
});
