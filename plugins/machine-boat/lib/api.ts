import { redactSecrets } from "@wy3z/bb-suite/machine-backend";

export const BOAT_API_BASE = "https://boat.dev/api/v1";
export const USER_AGENT = "bb-plugin-machine-boat";
export const SANDBOX_TYPES = ["small", "default", "large", "xlarge"] as const;
export type SandboxType = (typeof SANDBOX_TYPES)[number];
export const LIVE_STATES = new Set(["init", "provisioning", "provisioned", "cloning", "ready", "idle", "running", "archiving"]);
export const READY_STATES = new Set(["ready", "idle", "running"]);
export const MAX_TTL_SECONDS = 2_592_000;

export interface BoatSandbox {
  id: string;
  name: string;
  state: string;
  error: string | null;
  labels: Record<string, string>;
  type: string | null;
  vcpu: number | null;
  memoryGB: number | null;
  archiveAfter: string | null;
  stoppedAt: string | null;
  createdAt: string | null;
  snapshotCompletedAt: string | null;
  dataExpiredAt: string | null;
  hydrated: boolean | null;
  health: string | null;
  desktopAvailable: boolean;
  stop: { id: string; status: string; error: string | null } | null;
  costUsd: number | null;
}

export interface BoatLimits {
  accessTier: string | null;
  planKey: string | null;
  billingStatus: string | null;
  canStart: boolean;
  blockedReason: string | null;
  checkoutRequired: boolean;
  activeSandboxes: number | null;
  maxActiveSandboxes: number | null;
  includedHoursRemaining: number | null;
  includedPeriodEnd: string | null;
  walletUsd: number | null;
  machineTypes: Array<{ type: string; available: boolean; reason: string | null }>;
}

export interface SavedSnapshot {
  name: string;
  status: string;
  sourceSandboxId: string | null;
  createdAt: string | null;
  error: string | null;
}

export interface BoatEnvironment {
  name: string;
  isDefault: boolean;
  safeForThirdParties: boolean;
  passGithub: boolean;
  passSecrets: boolean;
  passSandboxCredentials: boolean;
  passAgentsCredentials: boolean;
  proxyAiCredentials: boolean;
}

export type CommandFrame =
  | { type: "started" }
  | { type: "stdout" | "stderr"; data: string }
  | { type: "exit"; exitCode: number | null; timedOut: boolean }
  | { type: "error"; error: string; message: string; retryable: boolean };

export class BoatApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  constructor(message: string, options: { status: number; code: string; retryable?: boolean; retryAfterMs?: number | null }) {
    super(message);
    this.name = "BoatApiError";
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof BoatApiError && (error.status === 404 || error.code === "not_found");
}

const BOAT_REDACTIONS: Array<[RegExp, string]> = [
  [/\b(?:boat|box)_[A-Za-z0-9_-]{20,}/g, "[redacted]"],
  [/([?&#](?:_token|token|access_token)=)[^&\s"']+/gi, "$1[redacted]"],
];

export function redactBoat(text: string, key?: string | null): string {
  let out = text;
  if (key) out = out.split(key).join("[redacted]");
  for (const [pattern, replacement] of BOAT_REDACTIONS) out = out.replace(pattern, replacement);
  return redactSecrets(out);
}

type Json = Record<string, unknown>;

function rec(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function toSandbox(raw: unknown): BoatSandbox {
  const value = rec(raw) ?? {};
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(rec(value.labels) ?? {})) if (typeof label === "string") labels[key] = label;
  const stop = rec(value.stop);
  return {
    id: str(value.id) ?? "",
    name: str(value.name) ?? "",
    state: str(value.state) ?? "unknown",
    error: str(value.error),
    labels,
    type: str(value.type),
    vcpu: num(value.vcpu),
    memoryGB: num(value.memoryGB),
    archiveAfter: str(value.archiveAfter),
    stoppedAt: str(value.stoppedAt),
    createdAt: str(value.createdAt),
    snapshotCompletedAt: str(value.snapshotCompletedAt),
    dataExpiredAt: str(value.dataExpiredAt),
    hydrated: typeof value.hydrated === "boolean" ? value.hydrated : null,
    health: str(value.health),
    desktopAvailable: value.desktopAvailable === true,
    stop: stop && str(stop.id) ? { id: str(stop.id)!, status: str(stop.status) ?? "unknown", error: str(stop.error) } : null,
    costUsd: num(rec(value.cost)?.dollars),
  };
}

function toLimits(raw: Json): BoatLimits {
  const included = rec(raw.planIncluded);
  const types = Array.isArray(raw.machineTypes) ? raw.machineTypes : [];
  return {
    accessTier: str(raw.accessTier),
    planKey: str(raw.sandboxPlanKey),
    billingStatus: str(raw.billingStatus),
    canStart: raw.canStart !== false,
    blockedReason: str(raw.startBlockedReason) ?? str(raw.blockedReason),
    checkoutRequired: raw.checkoutRequired === true,
    activeSandboxes: num(raw.activeSandboxes),
    maxActiveSandboxes: num(raw.maxActiveSandboxes),
    includedHoursRemaining: num(included?.vmHoursRemaining),
    includedPeriodEnd: str(included?.periodEnd),
    walletUsd: num(rec(raw.wallet)?.balanceDollars),
    machineTypes: types
      .map((entry) => rec(entry))
      .filter((entry): entry is Json => entry !== null && typeof entry.type === "string")
      .map((entry) => ({ type: entry.type as string, available: entry.available === true, reason: str(entry.reason) })),
  };
}

export function toEnvironment(raw: unknown): BoatEnvironment {
  const value = rec(raw) ?? {};
  return {
    name: str(value.name) ?? "",
    isDefault: value.isDefault === true,
    safeForThirdParties: value.safeForThirdParties !== false,
    passGithub: value.passGithub === true,
    passSecrets: value.passSecrets === true,
    passSandboxCredentials: value.passSandboxCredentials === true,
    passAgentsCredentials: value.passAgentsCredentials === true,
    proxyAiCredentials: value.proxyAiCredentials === true,
  };
}

function toSavedSnapshot(raw: unknown): SavedSnapshot {
  const value = rec(raw) ?? {};
  return {
    name: str(value.name) ?? "",
    status: str(value.status) ?? "unknown",
    sourceSandboxId: str(value.sourceSandboxId),
    createdAt: str(value.createdAt),
    error: str(value.error),
  };
}

export function parseFrame(line: string): CommandFrame | null {
  let value: Json | null;
  try {
    value = rec(JSON.parse(line));
  } catch {
    return null;
  }
  if (value === null) return null;
  switch (value.type) {
    case "started":
      return { type: "started" };
    case "stdout":
    case "stderr":
      return { type: value.type, data: typeof value.data === "string" ? value.data : "" };
    case "exit":
      return { type: "exit", exitCode: num(value.exitCode), timedOut: value.timedOut === true };
    case "error":
      return {
        type: "error",
        error: str(value.error) ?? "command_failed",
        message: str(value.message) ?? str(value.error) ?? "command failed",
        retryable: value.retryable === true,
      };
    default:
      return null;
  }
}

export interface BoatApiOptions {
  apiKey: () => Promise<string>;
  baseUrl?: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

interface RequestOptions {
  body?: unknown;
  query?: Array<[string, string]>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type BoatApi = ReturnType<typeof createBoatApi>;

export function createBoatApi(options: BoatApiOptions) {
  const baseUrl = options.baseUrl ?? BOAT_API_BASE;
  const doFetch = options.fetch ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;

  async function key(): Promise<string> {
    const value = (await options.apiKey()).trim();
    if (value === "") {
      throw new BoatApiError("Boat Sandbox: no boat.dev API key is set. Add one under Settings → Plugins → Boat Sandbox.", {
        status: 401,
        code: "missing_api_key",
      });
    }
    return value;
  }

  function url(path: string, query: Array<[string, string]> = []): string {
    const target = new URL(`${baseUrl}${path}`);
    for (const [name, value] of query) target.searchParams.append(name, value);
    return target.href;
  }

  function combined(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  async function failure(response: Response, apiKey: string): Promise<BoatApiError> {
    const text = await response.text().catch(() => "");
    let body: Json | null = null;
    try {
      body = rec(JSON.parse(text));
    } catch {
      body = null;
    }
    const error = rec(body?.error);
    const details = rec(error?.details);
    const code = str(body?.code) ?? str(error?.code) ?? `http_${response.status}`;
    const message = str(body?.message) ?? str(error?.message) ?? (text.trim().slice(0, 300) || response.statusText);
    const retryAfterHeader = Number(response.headers.get("retry-after"));
    const retryAfterSeconds = num(body?.retryAfterSeconds) ?? num(body?.retryAfter) ?? (Number.isFinite(retryAfterHeader) ? retryAfterHeader : null);
    return new BoatApiError(`boat.dev ${response.status} ${code}: ${redactBoat(message, apiKey)}`, {
      status: response.status,
      code,
      retryable: details?.retryable === true,
      retryAfterMs: retryAfterSeconds === null ? null : retryAfterSeconds * 1000,
    });
  }

  async function send(method: string, path: string, request: RequestOptions = {}): Promise<Response> {
    const apiKey = await key();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...request.headers,
    };
    if (request.body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await doFetch(url(path, request.query), {
        method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: combined(request.signal, request.timeoutMs ?? requestTimeoutMs),
      });
    } catch (error) {
      request.signal?.throwIfAborted();
      const text = error instanceof Error ? error.message : String(error);
      throw new BoatApiError(`boat.dev request failed: ${redactBoat(text, apiKey)}`, { status: 0, code: "network_error", retryable: true });
    }
    if (!response.ok) throw await failure(response, apiKey);
    return response;
  }

  async function json(method: string, path: string, request: RequestOptions = {}): Promise<Json> {
    const response = await send(method, path, request);
    const text = await response.text();
    if (text.trim() === "") return {};
    try {
      return rec(JSON.parse(text)) ?? {};
    } catch {
      throw new BoatApiError(`boat.dev answered ${method} ${path} with something that isn't JSON`, { status: response.status, code: "bad_response" });
    }
  }

  async function listSandboxes(query: Array<[string, string]>, signal?: AbortSignal) {
    const sandboxes: BoatSandbox[] = [];
    let deletedCostUsd: number | null = null;
    let cursor: string | null = null;
    for (let page = 0; page < 50; page += 1) {
      const body = await json("GET", "/sandboxes", {
        query: [...query, ["limit", "200"], ...(cursor ? ([["cursor", cursor]] as Array<[string, string]>) : [])],
        signal,
      });
      for (const raw of Array.isArray(body.sandboxes) ? body.sandboxes : []) sandboxes.push(toSandbox(raw));
      deletedCostUsd = num(rec(body.deletedCost)?.dollars) ?? deletedCostUsd;
      const info = rec(body.pageInfo);
      cursor = info?.hasMore === true ? str(info.nextCursor) : null;
      if (cursor === null) break;
    }
    return { sandboxes, deletedCostUsd };
  }

  return {
    async me(signal?: AbortSignal) {
      const body = await json("GET", "/me", { signal });
      const user = rec(body.user) ?? {};
      return { login: str(user.login), accountStatus: str(user.accountStatus), zeroDataRetention: user.zeroDataRetention === true };
    },
    async limits(signal?: AbortSignal): Promise<BoatLimits> {
      return toLimits(await json("GET", "/limits", { signal }));
    },
    listSandboxes,
    async environments(signal?: AbortSignal): Promise<BoatEnvironment[]> {
      const body = await json("GET", "/environments", { signal });
      return (Array.isArray(body.environments) ? body.environments : []).map(toEnvironment);
    },
    async getSandbox(id: string, signal?: AbortSignal): Promise<BoatSandbox> {
      return toSandbox((await json("GET", `/sandboxes/${encodeURIComponent(id)}`, { signal })).sandbox);
    },
    async createSandbox(body: Json, idempotencyKey: string, signal?: AbortSignal): Promise<BoatSandbox> {
      return toSandbox((await json("POST", "/sandboxes", { body, headers: { "Idempotency-Key": idempotencyKey }, signal })).sandbox);
    },
    async updateSandbox(id: string, body: Json, signal?: AbortSignal): Promise<BoatSandbox> {
      return toSandbox((await json("PATCH", `/sandboxes/${encodeURIComponent(id)}`, { body, signal })).sandbox);
    },
    async stopSandbox(id: string, signal?: AbortSignal): Promise<void> {
      await json("POST", `/sandboxes/${encodeURIComponent(id)}/stop`, { body: {}, signal });
    },
    async resumeSandbox(id: string, body: Json, signal?: AbortSignal): Promise<void> {
      await json("POST", `/sandboxes/${encodeURIComponent(id)}/resume`, { body, signal });
    },
    async deleteSandbox(id: string, signal?: AbortSignal): Promise<void> {
      await json("DELETE", `/sandboxes/${encodeURIComponent(id)}`, { headers: { "X-Ascii-Confirm-Delete": id }, signal });
    },
    async deleteSnapshot(id: string, signal?: AbortSignal): Promise<void> {
      await json("DELETE", `/snapshots/${encodeURIComponent(id)}`, { signal });
    },
    async savedSnapshot(name: string, signal?: AbortSignal): Promise<SavedSnapshot | null> {
      try {
        const body = await json("GET", `/saved-snapshots/${encodeURIComponent(name)}`, { signal });
        return toSavedSnapshot(body.snapshot ?? body.savedSnapshot ?? body);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async saveSnapshot(sandboxId: string, name: string, signal?: AbortSignal): Promise<void> {
      await json("POST", "/saved-snapshots", { body: { sandboxId, name }, signal });
    },
    async deleteSavedSnapshot(name: string, signal?: AbortSignal): Promise<void> {
      await json("DELETE", `/saved-snapshots/${encodeURIComponent(name)}`, { signal });
    },
    async desktop(sandboxId: string, theme: "light" | "dark" | null, signal?: AbortSignal): Promise<{ url: string | null; provisioning: boolean }> {
      const body = await json("POST", `/sandboxes/${encodeURIComponent(sandboxId)}/desktop`, {
        query: theme === null ? [] : [["theme", theme]],
        body: {},
        signal,
        timeoutMs: 45_000,
      });
      return { url: str(body.desktopUrl), provisioning: body.provisioning === true };
    },
    async writeFile(sandboxId: string, path: string, content: string, signal?: AbortSignal): Promise<void> {
      await json("PUT", `/sandboxes/${encodeURIComponent(sandboxId)}/files`, {
        body: { path, content: Buffer.from(content, "utf8").toString("base64"), encoding: "base64" },
        signal,
        timeoutMs: 120_000,
      });
    },
    async deleteFile(sandboxId: string, path: string, signal?: AbortSignal): Promise<void> {
      await json("DELETE", `/sandboxes/${encodeURIComponent(sandboxId)}/files`, { query: [["path", path]], signal });
    },
    async runCommand(
      sandboxId: string,
      request: { command: string; timeoutSeconds: number; signal: AbortSignal; onFrame: (frame: CommandFrame) => void },
    ): Promise<void> {
      const response = await send("POST", `/sandboxes/${encodeURIComponent(sandboxId)}/commands`, {
        body: { command: request.command, timeoutSeconds: request.timeoutSeconds, stream: true },
        signal: request.signal,
        timeoutMs: (request.timeoutSeconds + 90) * 1000,
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("ndjson") || response.body === null) {
        const body = rec(JSON.parse((await response.text()) || "{}")) ?? {};
        if (typeof body.stdout === "string" && body.stdout) request.onFrame({ type: "stdout", data: body.stdout });
        if (typeof body.stderr === "string" && body.stderr) request.onFrame({ type: "stderr", data: body.stderr });
        request.onFrame({ type: "exit", exitCode: num(body.exitCode), timedOut: body.timedOut === true });
        return;
      }
      const decoder = new TextDecoder();
      let pending = "";
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        pending += decoder.decode(chunk, { stream: true });
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          const frame = parseFrame(pending.slice(0, newline).trim());
          pending = pending.slice(newline + 1);
          if (frame !== null) request.onFrame(frame);
          newline = pending.indexOf("\n");
        }
      }
      pending += decoder.decode();
      const last = parseFrame(pending.trim());
      if (last !== null) request.onFrame(last);
    },
  };
}
