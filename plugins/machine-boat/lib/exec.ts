import { randomUUID } from "node:crypto";
import type { MachineExecutorRequest } from "@get-bb/plugin-sdk";
import { BoatApiError, type BoatApi } from "./api.ts";

export const MAX_COMMAND_SECONDS = 600;
export const STDIN_DIR = "/tmp";
const RETRIES = 4;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function commandLine(argv: readonly string[], stdinPath: string | null): string {
  if (argv.length === 0) throw new Error("Boat Sandbox: empty command");
  const run = argv.map(shellQuote).join(" ");
  const script =
    stdinPath === null
      ? `exec </dev/null && exec ${run}`
      : `exec <${shellQuote(stdinPath)} && rm -f ${shellQuote(stdinPath)} && exec ${run}`;
  return `bash -lc ${shellQuote(script)}`;
}

export function commandSeconds(timeoutMs: number): number {
  return Math.min(MAX_COMMAND_SECONDS, Math.max(1, Math.ceil(timeoutMs / 1000)));
}

function retryableBeforeStart(error: unknown): boolean {
  if (!(error instanceof BoatApiError)) return false;
  if (error.code === "sandbox_starting" || error.code === "boat_starting") return true;
  return error.code === "sandbox_direct_failed" && error.retryable && /restoring/i.test(error.message);
}

export interface ExecDeps {
  api: Pick<BoatApi, "runCommand" | "writeFile" | "deleteFile">;
  sleep?: (ms: number) => Promise<void>;
}

export async function execInSandbox(deps: ExecDeps, sandboxId: string, request: MachineExecutorRequest): Promise<{ exitCode: number }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stdinPath = request.stdin.length > 0 ? `${STDIN_DIR}/.bb-boat-stdin-${randomUUID()}` : null;
  if (stdinPath !== null) await deps.api.writeFile(sandboxId, stdinPath, request.stdin, request.signal);
  let started = false;
  let ran = false;
  let finished = false;
  try {
    for (let attempt = 1; ; attempt += 1) {
      let exitCode: number | null = null;
      let failure: { error: string; message: string; retryable: boolean } | null = null;
      try {
        await deps.api.runCommand(sandboxId, {
          command: commandLine(request.command, stdinPath),
          timeoutSeconds: commandSeconds(request.timeoutMs),
          signal: request.signal,
          onFrame: (frame) => {
            if (frame.type === "started") started = true;
            else if (frame.type === "stdout" || frame.type === "stderr") {
              started = true;
              ran = true;
              request.onOutput(frame.data);
            } else if (frame.type === "exit") {
              started = true;
              ran = true;
              exitCode = frame.exitCode ?? (frame.timedOut ? 124 : 1);
            } else if (frame.type === "error") failure = frame;
          },
        });
      } catch (error) {
        request.signal.throwIfAborted();
        if (!started && attempt < RETRIES && retryableBeforeStart(error)) {
          await sleep(2_000 * attempt);
          continue;
        }
        throw error;
      }
      if (exitCode !== null) {
        finished = true;
        return { exitCode };
      }
      const failed = failure as { error: string; message: string; retryable: boolean } | null;
      if (failed !== null && failed.retryable && !ran && attempt < RETRIES) {
        started = false;
        await sleep(2_000 * attempt);
        continue;
      }
      throw new Error(
        failed === null
          ? "Boat Sandbox: the command stream ended without an exit status"
          : `Boat Sandbox: the command failed to run (${failed.error}: ${failed.message})`,
      );
    }
  } finally {
    if (stdinPath !== null && !finished) {
      await deps.api.deleteFile(sandboxId, stdinPath, AbortSignal.timeout(15_000)).catch(() => undefined);
    }
  }
}
