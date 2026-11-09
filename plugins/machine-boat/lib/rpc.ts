import { cliCommand, defineCli, defineRpcContract, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { readSandboxResource, type SandboxBackendRegistration } from "@wy3z/bb-suite/machine-backend/server";
import { z } from "zod";
import { BoatApiError, LIVE_STATES, redactBoat, type BoatSandbox } from "./api.ts";
import { DISPLAY_NAME, LABEL_NAME, PROVIDER_ID, type BoatBackend } from "./backend.ts";
import { HOURLY_RATE_USD, type BoatSettings } from "./settings.ts";

const empty = z.object({}).strict();

export const accountOutput = z.object({
  available: z.boolean(),
  message: z.string(),
  providerId: z.literal(PROVIDER_ID),
  login: z.string().nullable(),
  plan: z.string().nullable(),
  billingStatus: z.string().nullable(),
  canStart: z.boolean().nullable(),
  activeSandboxes: z.number().nullable(),
  maxActiveSandboxes: z.number().nullable(),
  includedHoursRemaining: z.number().nullable(),
  includedPeriodEnd: z.string().nullable(),
  walletUsd: z.number().nullable(),
  sizes: z.array(z.object({ type: z.string(), available: z.boolean(), reason: z.string().nullable() })),
});
export type AccountInspection = z.output<typeof accountOutput>;

export const usageOutput = z.object({
  providerId: z.literal(PROVIDER_ID),
  month: z.string(),
  capUsd: z.number().nullable(),
  size: z.string(),
  hourlyRateUsd: z.number(),
  vendor: z.object({ usd: z.number(), deletedUsd: z.number().nullable(), sandboxes: z.number(), running: z.number() }).nullable(),
  vendorError: z.string().nullable(),
  estimate: z.object({ runningMs: z.number(), usd: z.number().nullable() }),
  refusal: z.string().nullable(),
});
export type UsageReport = z.output<typeof usageOutput>;

export const machineInput = z.object({ hostId: z.string().min(1).max(200) }).strict();
export const machineOutput = z.object({
  providerId: z.literal(PROVIDER_ID),
  hostId: z.string(),
  name: z.string(),
  sandboxId: z.string().nullable(),
  state: z.string(),
  running: z.boolean(),
  size: z.string().nullable(),
  vcpu: z.number().nullable(),
  memoryGB: z.number().nullable(),
  expiresAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
  snapshotCompletedAt: z.string().nullable(),
  hydrated: z.boolean().nullable(),
  health: z.string().nullable(),
  desktopAvailable: z.boolean(),
  monthUsd: z.number().nullable(),
  keepSnapshot: z.object({ status: z.string(), createdAt: z.string().nullable() }).nullable(),
});
export type MachineInspection = z.output<typeof machineOutput>;

export const boatRpcContract = defineRpcContract({
  "account.inspect": { input: empty, output: accountOutput },
  "usage.get": { input: empty, output: usageOutput },
  "machine.inspect": { input: machineInput, output: machineOutput },
});

export interface BoatRpcDeps {
  backend: BoatBackend;
  registration: Pick<SandboxBackendRegistration, "usage" | "refusal">;
  settings: () => Promise<BoatSettings>;
  api: { savedSnapshot(name: string, signal?: AbortSignal): Promise<{ status: string; createdAt: string | null } | null>; listSandboxes: BoatBackendList };
  machines: {
    host(hostId: string): Promise<{ machineProviderId: string | null } | null>;
    resource(hostId: string): Promise<unknown>;
  };
}

type BoatBackendList = (query: Array<[string, string]>, signal?: AbortSignal) => Promise<{ sandboxes: BoatSandbox[]; deletedCostUsd: number | null }>;

function text(error: unknown): string {
  return redactBoat(error instanceof Error ? error.message : String(error));
}

export function createBoatService(deps: BoatRpcDeps) {
  async function inspectAccount(): Promise<AccountInspection> {
    const base: AccountInspection = {
      available: false,
      message: "",
      providerId: PROVIDER_ID,
      login: null,
      plan: null,
      billingStatus: null,
      canStart: null,
      activeSandboxes: null,
      maxActiveSandboxes: null,
      includedHoursRemaining: null,
      includedPeriodEnd: null,
      walletUsd: null,
      sizes: [],
    };
    const settings = await deps.settings();
    if (settings.apiKey.trim() === "") return { ...base, message: `${DISPLAY_NAME}: no boat.dev API key is set.` };
    const availability = await deps.backend.availability!();
    let filled = base;
    const me = await deps.backend.me(AbortSignal.timeout(15_000)).catch(() => null);
    if (me !== null) filled = { ...filled, login: me.login };
    try {
      const limits = await deps.backend.limits(AbortSignal.timeout(15_000));
      filled = {
        ...filled,
        plan: limits.accessTier ?? limits.planKey,
        billingStatus: limits.billingStatus,
        canStart: limits.canStart,
        activeSandboxes: limits.activeSandboxes,
        maxActiveSandboxes: limits.maxActiveSandboxes,
        includedHoursRemaining: limits.includedHoursRemaining,
        includedPeriodEnd: limits.includedPeriodEnd,
        walletUsd: limits.walletUsd,
        sizes: limits.machineTypes,
      };
    } catch (error) {
      if (!(error instanceof BoatApiError && error.status === 403)) {
        return { ...filled, message: availability.status === "available" ? text(error) : availability.message };
      }
    }
    const available = availability.status === "available";
    return {
      ...filled,
      available,
      message: available
        ? `${DISPLAY_NAME}: connected to boat.dev${filled.plan ? ` (${filled.plan})` : ""}; new sandboxes are ${settings.size}.`
        : availability.message,
    };
  }

  async function usage(): Promise<UsageReport> {
    const settings = await deps.settings();
    const estimate = await deps.registration.usage();
    let vendor: UsageReport["vendor"] = null;
    let vendorError: string | null = null;
    if (settings.apiKey.trim() !== "") {
      try {
        vendor = await deps.backend.spend(AbortSignal.timeout(15_000));
      } catch (error) {
        vendorError = text(error);
      }
    } else vendorError = "no boat.dev API key is set";
    return {
      providerId: PROVIDER_ID,
      month: estimate.month,
      capUsd: settings.monthlyCapUsd === 0 ? null : settings.monthlyCapUsd,
      size: settings.size,
      hourlyRateUsd: HOURLY_RATE_USD[settings.size],
      vendor,
      vendorError,
      estimate: { runningMs: estimate.runningMs, usd: estimate.estimatedUsd },
      refusal: await deps.registration.refusal(),
    };
  }

  async function inspectMachine(hostId: string): Promise<MachineInspection> {
    const host = await deps.machines.host(hostId);
    if (host === null || host.machineProviderId !== PROVIDER_ID) {
      throw new Error(`${DISPLAY_NAME}: ${hostId} isn't a ${DISPLAY_NAME} machine.`);
    }
    const raw = await deps.machines.resource(hostId);
    if (raw === null || raw === undefined) throw new Error(`${DISPLAY_NAME}: ${hostId} has no recorded sandbox yet.`);
    const resource = readSandboxResource(raw);
    const signal = AbortSignal.timeout(20_000);
    const { sandboxes } = await deps.api.listSandboxes(
      [
        ["label", `${LABEL_NAME}=${resource.name}`],
        ["include", "cost"],
      ],
      signal,
    );
    const owned = sandboxes.filter((candidate) => candidate.labels[LABEL_NAME] === resource.name && candidate.state !== "cancelled");
    const sandbox =
      owned.find((candidate) => candidate.id === resource.sandboxId) ?? owned.find((candidate) => LIVE_STATES.has(candidate.state)) ?? owned[0] ?? null;
    const keep = await deps.api.savedSnapshot(resource.name, signal).catch(() => null);
    const monthUsd = owned.some((candidate) => candidate.costUsd !== null)
      ? owned.reduce((sum, candidate) => sum + (candidate.costUsd ?? 0), 0)
      : null;
    return {
      providerId: PROVIDER_ID,
      hostId,
      name: resource.name,
      sandboxId: sandbox?.id ?? resource.sandboxId,
      state: sandbox?.state ?? "gone",
      running: sandbox !== null && LIVE_STATES.has(sandbox.state),
      size: sandbox?.type ?? null,
      vcpu: sandbox?.vcpu ?? null,
      memoryGB: sandbox?.memoryGB ?? null,
      expiresAt: sandbox?.archiveAfter ?? null,
      stoppedAt: sandbox?.stoppedAt ?? null,
      snapshotCompletedAt: sandbox?.snapshotCompletedAt ?? null,
      hydrated: sandbox?.hydrated ?? null,
      health: sandbox?.health ?? null,
      desktopAvailable: sandbox?.desktopAvailable ?? false,
      monthUsd,
      keepSnapshot: keep === null ? null : { status: keep.status, createdAt: keep.createdAt },
    };
  }

  return { inspectAccount, usage, inspectMachine };
}

export type BoatService = ReturnType<typeof createBoatService>;

function usd(value: number | null): string {
  if (value === null) return "n/a";
  return `$${value > 0 && value < 0.1 ? value.toFixed(4).replace(/0+$/, "") : value.toFixed(2)}`;
}

export function usageSummary(report: UsageReport): string {
  const lines = [
    `${DISPLAY_NAME} usage for ${report.month}`,
    report.vendor !== null
      ? `boat.dev list price: ${usd(report.vendor.usd)} across ${report.vendor.sandboxes} sandbox(es), ${report.vendor.running} running${report.vendor.deletedUsd ? ` (${usd(report.vendor.deletedUsd)} from deleted ones)` : ""}`
      : `boat.dev reading unavailable: ${report.vendorError ?? "unknown"}`,
    `BB's own estimate: ${(report.estimate.runningMs / 3_600_000).toFixed(2)} h, ${usd(report.estimate.usd)} at ${usd(report.hourlyRateUsd)}/h (${report.size})`,
    `Monthly cap: ${report.capUsd === null ? "none" : usd(report.capUsd)}`,
  ];
  if (report.refusal !== null) lines.push(report.refusal);
  return `${lines.join("\n")}\n`;
}

export function machineSummary(machine: MachineInspection): string {
  return `${[
    `${machine.name} (${machine.hostId})`,
    `boat sandbox ${machine.sandboxId ?? "none"}: ${machine.state}${machine.size ? `, ${machine.size}` : ""}${machine.vcpu ? ` (${machine.vcpu} vCPU, ${machine.memoryGB} GB)` : ""}`,
    `Auto-stop: ${machine.expiresAt ?? (machine.running ? "off" : "n/a")}`,
    `Last snapshot: ${machine.snapshotCompletedAt ?? "none"}${machine.stoppedAt ? `; stopped ${machine.stoppedAt}` : ""}`,
    `This month: ${usd(machine.monthUsd)}`,
    `Saved snapshot for 14-day keep: ${machine.keepSnapshot === null ? "none" : `${machine.keepSnapshot.status} (${machine.keepSnapshot.createdAt ?? "?"})`}`,
  ].join("\n")}\n`;
}

export function registerBoatRpcAndCli(bb: Pick<BbPluginApi, "rpc" | "cli">, service: BoatService): void {
  bb.rpc.register(boatRpcContract, {
    "account.inspect": () => service.inspectAccount(),
    "usage.get": () => service.usage(),
    "machine.inspect": ({ hostId }) => service.inspectMachine(hostId),
  });

  const json = { type: "boolean", description: "Emit JSON" } as const;
  const guard = async (run: () => Promise<{ exitCode: number; stdout: string }>) => {
    try {
      return await run();
    } catch (error) {
      throw new PluginCliError(text(error), { code: "boat_failed" });
    }
  };

  bb.cli.register(
    defineCli({
      name: "boat",
      summary: "boat.dev cloud machines for BB threads: account check, spend and VM facts",
      commands: {
        "account inspect": cliCommand({
          summary: "Test the configured boat.dev account without creating a sandbox",
          options: { json },
          run: (input) =>
            guard(async () => {
              const result = await service.inspectAccount();
              return { exitCode: result.available ? 0 : 1, stdout: input.options.json ? `${JSON.stringify(result)}\n` : `${result.message}\n` };
            }),
        }),
        usage: cliCommand({
          summary: "Show this month's boat.dev machine time and the monthly cap",
          options: { json },
          run: (input) =>
            guard(async () => {
              const result = await service.usage();
              return { exitCode: 0, stdout: input.options.json ? `${JSON.stringify(result)}\n` : usageSummary(result) };
            }),
        }),
        "machine inspect": cliCommand({
          summary: "Show the boat.dev VM behind a BB machine",
          positionals: [{ name: "host-id", description: "BB host id of a Boat Sandbox machine (bb machine list --all)", required: true }],
          options: { json },
          run: (input) =>
            guard(async () => {
              const result = await service.inspectMachine(input.positionals["host-id"]);
              return { exitCode: 0, stdout: input.options.json ? `${JSON.stringify(result)}\n` : machineSummary(result) };
            }),
        }),
      },
    }),
  );
}
