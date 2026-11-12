import type { SandboxPolicyInput } from "@wy3z/bb-suite/machine-backend";
import { z } from "zod";
import { SANDBOX_TYPES, type SandboxType } from "./api.ts";

export const HOURLY_RATE_USD: Record<SandboxType, number> = {
  small: 0.018,
  default: 0.036,
  large: 0.072,
  xlarge: 0.2,
};

const MINUTES_PER_YEAR = 525_600;
export const ENVIRONMENT_NAME = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
const environmentSchema = z
  .string()
  .trim()
  .regex(ENVIRONMENT_NAME, "Use a boat environment name (letters, digits, dot, dash, underscore), or leave it empty");

export const settingDescriptors = {
  apiKey: {
    type: "string",
    label: "boat.dev API key",
    description:
      "A boat API key (starts with boat_). Create it with boat api-key create bb --preset ci --ttl never, and change it later with boat api-key rotate so it keeps the right to delete the VMs it created.",
    secret: true,
  },
  size: {
    type: "select",
    label: "Size",
    description: "Machine size for new sandboxes. Resume moves a stopped sandbox to the current size.",
    options: [...SANDBOX_TYPES] as string[],
    experimental_optionLabels: {
      small: "small: 2 vCPU, 4 GB, $0.018/h",
      default: "default: 4 vCPU, 8 GB, $0.036/h",
      large: "large: 8 vCPU, 16 GB, $0.072/h (paid plans)",
      xlarge: "xlarge: 16 vCPU, 32 GB, $0.20/h ($100 plan)",
    },
    default: "small",
  },
  environment: {
    type: "string",
    label: "boat environment",
    description:
      "The boat environment new sandboxes start in. Name one with only Agents credentials on (and Safe for third parties off) so VMs get the Claude, ChatGPT and OpenCode Go logins you connected on boat.dev. Every other switch left on in it also reaches every VM. Empty gives sandboxes nothing from your boat account.",
    default: "",
    experimental_schema: environmentSchema,
  },
  idleMinutes: {
    type: "number",
    label: "Idle minutes",
    description: "Suspend a sandbox after this many minutes without thread or terminal activity. 0 never suspends it for idleness.",
    default: 15,
    experimental_schema: z.number().int().min(0).max(10_080),
  },
  ttlHours: {
    type: "number",
    label: "TTL hours",
    description:
      "boat stops the sandbox this long after it starts, even if BB is down. Active threads keep extending it. 0 turns boat's auto-stop off. The free trial allows 2 hours at most.",
    default: 2,
    experimental_schema: z.number().min(0).max(720),
  },
  maxConcurrent: {
    type: "number",
    label: "Max concurrent",
    description: "Running sandboxes allowed at once. Suspended ones don't count. 0 means no limit.",
    default: 2,
    experimental_schema: z.number().int().min(0).max(1_000),
  },
  monthlyCapUsd: {
    type: "number",
    label: "Monthly cap (USD)",
    description:
      "Refuse new and resumed sandboxes once this month's machine time, at boat's list price, reaches this amount. Running sandboxes are suspended. 0 means no cap.",
    default: 30,
    experimental_schema: z.number().min(0).max(100_000),
  },
  keepStoppedDays: {
    type: "number",
    label: "Keep stopped sandboxes after (days)",
    description:
      "boat may clean up a stopped sandbox's disk after 14 days. A sandbox still stopped after this many days gets a saved snapshot so it can come back. Needs a paid plan; extras past the plan's allowance cost $0.056 a day. 0 turns it off.",
    default: 12,
    experimental_schema: z.number().int().min(0).max(13),
  },
} as const;

export interface BoatSettings {
  apiKey: string;
  size: SandboxType;
  environment: string;
  idleMinutes: number;
  ttlHours: number;
  maxConcurrent: number;
  monthlyCapUsd: number;
  keepStoppedDays: number;
}

const settingsSchema = z.object({
  apiKey: z.string().catch(""),
  size: z.enum(SANDBOX_TYPES).catch("small"),
  environment: z.string().trim().catch(""),
  idleMinutes: z.number().int().min(0).catch(15),
  ttlHours: z.number().min(0).max(720).catch(2),
  maxConcurrent: z.number().int().min(0).catch(2),
  monthlyCapUsd: z.number().min(0).catch(30),
  keepStoppedDays: z.number().int().min(0).max(13).catch(12),
});

export function readBoatSettings(values: Partial<Record<keyof BoatSettings, unknown>>): BoatSettings {
  return settingsSchema.parse(values);
}

export function policyFrom(settings: BoatSettings): SandboxPolicyInput {
  return {
    idleMinutes: settings.idleMinutes === 0 ? null : settings.idleMinutes,
    ttlMinutes: settings.ttlHours === 0 ? MINUTES_PER_YEAR : settings.ttlHours * 60,
    maxConcurrent: settings.maxConcurrent === 0 ? null : settings.maxConcurrent,
    monthlyCapUsd: settings.monthlyCapUsd === 0 ? null : settings.monthlyCapUsd,
    hourlyRateUsd: HOURLY_RATE_USD[settings.size],
  };
}
