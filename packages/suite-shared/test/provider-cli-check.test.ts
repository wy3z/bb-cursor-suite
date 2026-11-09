import { describe, expect, test } from "bun:test";
import type { MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { chainDispatchChecks, createProviderCliCheck } from "../src/provider-cli-check-server.ts";

type Status = Record<string, { installed: boolean; displayName: string; executableName: string; installAction: { command: string; kind: "install"; label: "Install" } | null }>;

function context(over: { provider?: string; machineProviderId?: string; phase?: string; host?: null; attempt?: string } = {}): MessageDispatchHookContext {
  const host =
    over.host === null
      ? null
      : { id: "host_abc", name: "Boat Sandbox abc", machineProviderId: over.machineProviderId ?? "fake-sandbox", lifecycle: { phase: over.phase ?? "active" } };
  return { host, attempt: over.attempt ?? "start-turn", requestedExecution: { providerId: over.provider ?? "codex" } } as unknown as MessageDispatchHookContext;
}

const codex = (installed: boolean, installer = true): Status => ({
  codex: {
    installed,
    displayName: "Codex",
    executableName: "codex",
    installAction: installer ? { command: "npm i -g @openai/codex", kind: "install", label: "Install" } : null,
  },
});

function fake(status: Status | Error, install: () => Promise<unknown[]> = async () => [{ type: "completed", provider: "codex", exitCode: 0, signal: null, success: true }]) {
  const calls = { status: 0, install: 0, recheck: 0 };
  const logs: string[] = [];
  let release: () => void = () => undefined;
  const rechecked = new Promise<void>((resolve) => (release = resolve));
  const bb = {
    log: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
    sdk: {
      hosts: {
        providerCliStatus: async () => {
          calls.status += 1;
          if (status instanceof Error) throw status;
          return status;
        },
        installProviderCli: async () => {
          calls.install += 1;
          return install();
        },
      },
    },
    experimental_hooks: {
      recheck: async () => {
        calls.recheck += 1;
        release();
      },
    },
  };
  return { bb: bb as never, calls, logs, rechecked };
}

describe("provider CLI check", () => {
  test("ignores other machines, missing hosts, joins and suspended sandboxes", async () => {
    const f = fake(codex(false));
    const check = createProviderCliCheck(f.bb, "fake-sandbox", { label: "Fake Sandbox" });
    for (const c of [context({ machineProviderId: "boat-sandbox" }), context({ host: null }), context({ attempt: "join-turn" }), context({ phase: "suspended" })]) {
      expect(await check(c)).toEqual({ action: "proceed" });
    }
    expect(f.calls.status).toBe(0);
  });

  test("proceeds when the CLI is installed or BB has no CLI entry for the provider", async () => {
    const f = fake(codex(true));
    const check = createProviderCliCheck(f.bb, "fake-sandbox", { label: "Fake Sandbox" });
    expect(await check(context())).toEqual({ action: "proceed" });
    expect(await check(context({ provider: "acp-opencode" }))).toEqual({ action: "proceed" });
    expect(f.calls.install).toBe(0);
  });

  test("proceeds when status can't be read rather than blocking the turn", async () => {
    const f = fake(new Error("daemon offline"));
    expect(await createProviderCliCheck(f.bb, "fake-sandbox", { label: "Fake Sandbox" })(context())).toEqual({ action: "proceed" });
  });

  test("waits, installs in the background once, rechecks, then proceeds", async () => {
    const f = fake(codex(false));
    const check = createProviderCliCheck(f.bb, "fake-sandbox", { now: () => 1_000 });
    const first = await check(context());
    expect(first).toEqual({ action: "wait", reason: "Installing Codex on Boat Sandbox abc…", sendAt: 61_000 });
    await f.rechecked;
    expect(f.calls.install).toBe(1);
    expect(f.calls.recheck).toBe(1);
    expect(await check(context())).toEqual({ action: "proceed" });
    expect(f.calls.status).toBe(1);
  });

  test("a second dispatch during the install waits without starting another", async () => {
    let finish: (events: unknown[]) => void = () => undefined;
    const f = fake(codex(false), () => new Promise((resolve) => (finish = resolve)));
    const check = createProviderCliCheck(f.bb, "fake-sandbox", { now: () => 0 });
    await check(context());
    expect(await check(context())).toMatchObject({ action: "wait" });
    expect(f.calls.install).toBe(1);
    finish([{ type: "completed", provider: "codex", exitCode: 0, signal: null, success: true }]);
    await f.rechecked;
  });

  test("rejects with the fix when the install fails, without leaking secrets", async () => {
    const f = fake(codex(false), async () => [
      { type: "output", provider: "codex", stream: "stderr", text: "npm ERR! 403 token=ghp_abcdefghijklmnopqrstuvwxyz123456\n" },
      { type: "completed", provider: "codex", exitCode: 1, signal: null, success: false },
    ]);
    const check = createProviderCliCheck(f.bb, "fake-sandbox", { label: "Fake Sandbox" });
    await check(context());
    await f.rechecked;
    const decision = await check(context());
    expect(decision.action).toBe("reject");
    const message = (decision as { message: string }).message;
    expect(message).toContain("bb machine provider-cli install host_abc codex");
    expect(message).not.toContain("ghp_");
  });

  test("rejects when BB has no installer for the provider", async () => {
    const f = fake(codex(false, false));
    const decision = await createProviderCliCheck(f.bb, "fake-sandbox", { label: "Fake Sandbox" })(context());
    expect(decision).toMatchObject({ action: "reject" });
    expect(f.calls.install).toBe(0);
  });
});

describe("provider CLI check deadlines and caching", () => {
  test("gives up on an install that never finishes and tells the user how to finish it", async () => {
    let clock = 0;
    let finish: (events: unknown[]) => void = () => undefined;
    const f = fake(codex(false), () => new Promise((resolve) => (finish = resolve)));
    const check = createProviderCliCheck(f.bb, "fake-sandbox", { label: "Fake Sandbox", now: () => clock });
    expect(await check(context())).toMatchObject({ action: "wait" });
    clock = 9 * 60_000;
    expect(await check(context())).toMatchObject({ action: "wait" });
    clock = 10 * 60_000;
    const decision = await check(context());
    expect(decision).toMatchObject({ action: "reject" });
    expect((decision as { message: string }).message).toContain("bb machine provider-cli install host_abc codex");
    finish([{ type: "completed", provider: "codex", exitCode: 0, signal: null, success: true }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.calls.recheck).toBe(0);
    expect(await check(context())).toEqual({ action: "proceed" });
    expect(f.calls.status).toBe(1);
  });

  test("remembers an installed CLI for a few minutes instead of asking the machine on every message", async () => {
    let clock = 0;
    const f = fake(codex(true));
    const check = createProviderCliCheck(f.bb, "fake-sandbox", { now: () => clock });
    expect(await check(context())).toEqual({ action: "proceed" });
    clock = 4 * 60_000;
    expect(await check(context())).toEqual({ action: "proceed" });
    expect(f.calls.status).toBe(1);
    clock = 6 * 60_000;
    expect(await check(context())).toEqual({ action: "proceed" });
    expect(f.calls.status).toBe(2);
  });
});

describe("chainDispatchChecks", () => {
  test("stops at the first non-proceed decision", async () => {
    let second = 0;
    const chain = chainDispatchChecks([
      async () => ({ action: "reject", message: "no login" }),
      async () => {
        second += 1;
        return { action: "proceed" };
      },
    ]);
    expect(await chain(context())).toEqual({ action: "reject", message: "no login" });
    expect(second).toBe(0);
    expect(await chainDispatchChecks([async () => ({ action: "proceed" })])(context())).toEqual({ action: "proceed" });
  });
});
