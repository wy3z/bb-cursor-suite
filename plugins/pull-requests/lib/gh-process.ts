import { tmpdir } from "node:os";
import { cachedExecutable } from "@wy3z/bb-suite/git";
import { cliGitEnv } from "@wy3z/bb-suite/git-safety";

export interface GhProcess {
  file: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function ghProcess(source: NodeJS.ProcessEnv = process.env): GhProcess | null {
  const file = cachedExecutable("gh", source);
  if (file === null) return null;
  return {
    file,
    cwd: tmpdir(),
    env: {
      ...cliGitEnv({ git: cachedExecutable("git", source), repository: false, source }),
      GH_PROMPT_DISABLED: "1",
      GH_HOST: "github.com",
      NO_COLOR: "1",
    },
  };
}
