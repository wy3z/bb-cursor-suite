import type { SandboxPolicyInput } from "@wy3z/bb-suite/machine-backend";
import { z } from "zod";

const MINUTES_PER_YEAR = 525_600;

export const settingDescriptors = {
  image: {
    type: "string",
    label: "Image",
    description:
      "Leave empty for the built-in Debian image (Node 22, git, gh, Chromium and fonts; agent CLIs install into ~/.local on first use). A custom image needs sh, Node.js 22.19 or newer, curl, git and ps, and should run as a non-root user.",
    default: "",
    experimental_schema: z.string().trim().max(256).regex(/^[^\s]*$/, "No spaces in an image reference"),
  },
  cpus: {
    type: "number",
    label: "CPU limit",
    description: "CPUs each sandbox may use (docker --cpus).",
    default: 2,
    experimental_schema: z.number().min(0.25).max(64),
  },
  memoryGb: {
    type: "number",
    label: "Memory limit (GB)",
    description: "Memory each sandbox may use. Swap is disabled, so this is a hard cap.",
    default: 4,
    experimental_schema: z.number().min(0.5).max(256),
  },
  shmMb: {
    type: "number",
    label: "Shared memory (MB)",
    description: "Size of /dev/shm. Headless Chromium needs more than Docker's 64 MB default.",
    default: 1024,
    experimental_schema: z.number().int().min(64).max(16384),
  },
  idleMinutes: {
    type: "number",
    label: "Idle minutes",
    description: "Stop a sandbox after this many minutes without thread or terminal activity. 0 never stops it for idleness.",
    default: 15,
    experimental_schema: z.number().int().min(0).max(10080),
  },
  ttlHours: {
    type: "number",
    label: "TTL hours",
    description:
      "Hard backstop: the container stops itself this long after it starts, even if BB is down. Active threads keep extending it. 0 turns it off.",
    default: 2,
    experimental_schema: z.number().min(0).max(720),
  },
  maxConcurrent: {
    type: "number",
    label: "Max concurrent",
    description: "Running sandboxes allowed at once. Suspended ones don't count. 0 means no limit.",
    default: 2,
    experimental_schema: z.number().int().min(0).max(64),
  },
} as const;

export interface DockerSettings {
  image: string;
  cpus: number;
  memoryGb: number;
  shmMb: number;
  idleMinutes: number;
  ttlHours: number;
  maxConcurrent: number;
}

const settingsSchema = z.object({
  image: z.string().trim().catch(""),
  cpus: z.number().min(0.25).max(64).catch(2),
  memoryGb: z.number().min(0.5).max(256).catch(4),
  shmMb: z.number().int().min(64).max(16384).catch(1024),
  idleMinutes: z.number().int().min(0).catch(15),
  ttlHours: z.number().min(0).catch(2),
  maxConcurrent: z.number().int().min(0).catch(2),
});

export function readDockerSettings(values: Partial<Record<keyof DockerSettings, unknown>>): DockerSettings {
  return settingsSchema.parse(values);
}

export function policyFrom(settings: DockerSettings): SandboxPolicyInput {
  return {
    idleMinutes: settings.idleMinutes === 0 ? null : settings.idleMinutes,
    ttlMinutes: settings.ttlHours === 0 ? MINUTES_PER_YEAR : settings.ttlHours * 60,
    maxConcurrent: settings.maxConcurrent === 0 ? null : settings.maxConcurrent,
    monthlyCapUsd: null,
    hourlyRateUsd: null,
  };
}
