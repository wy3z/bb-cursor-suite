import { spawn } from "node:child_process";

export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DockerRunOptions {
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onOutput?: (chunk: string) => void;
}

export type DockerRunner = (args: string[], options?: DockerRunOptions) => Promise<DockerResult>;

const OUTPUT_CAP = 4 * 1024 * 1024;
export const TIMEOUT_EXIT = 124;

export function createDockerRunner(binary = "docker"): DockerRunner {
  return (args, options = {}) =>
    new Promise<DockerResult>((resolve, reject) => {
      const { signal, timeoutMs, onOutput, stdin } = options;
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      const child = spawn(binary, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, LC_ALL: "C" },
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const collect = (target: "stdout" | "stderr") => (data: Buffer) => {
        const text = data.toString("utf8");
        if (onOutput) onOutput(text);
        if (target === "stdout" && stdout.length < OUTPUT_CAP) stdout += text;
        if (target === "stderr" && stderr.length < OUTPUT_CAP) stderr += text;
      };
      child.stdout.on("data", collect("stdout"));
      child.stderr.on("data", collect("stderr"));
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, timeoutMs);
      const onAbort = () => child.kill("SIGKILL");
      signal?.addEventListener("abort", onAbort, { once: true });
      const finish = (run: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        run();
      };
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (code) =>
        finish(() => {
          if (signal?.aborted) reject(signal.reason ?? new Error("aborted"));
          else resolve({ code: timedOut ? TIMEOUT_EXIT : (code ?? 1), stdout, stderr });
        }),
      );
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin ?? "");
    });
}

export class DockerError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: DockerResult,
  ) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 500);
    super(`docker ${args[0]} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`);
    this.name = "DockerError";
  }
}

export async function docker(run: DockerRunner, args: string[], options?: DockerRunOptions): Promise<string> {
  const result = await run(args, options);
  if (result.code !== 0) throw new DockerError(args, result);
  return result.stdout;
}

export function isMissing(error: unknown): boolean {
  return error instanceof DockerError && /no such (container|object|network|volume|image)|not found/i.test(error.result.stderr);
}
