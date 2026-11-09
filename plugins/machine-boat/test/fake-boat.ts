export const TEST_KEY = "boat_testkey0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCD";

export interface FakeSandbox {
  id: string;
  name: string;
  state: string;
  labels: Record<string, string>;
  type: string;
  ttlSeconds: number | null;
  archiveAfter: string | null;
  stoppedAt: string | null;
  dataExpiredAt: string | null;
  costUsd: number;
  body: Record<string, unknown>;
  pollsUntilReady: number;
  pollsUntilArchived: number;
}

export interface Recorded {
  method: string;
  path: string;
  search: URLSearchParams;
  headers: Headers;
  body: Record<string, unknown> | null;
}

type Fault = { status: number; code: string; message?: string; retryAfter?: number; retryable?: boolean; times?: number };

export class FakeBoat {
  sandboxes = new Map<string, FakeSandbox>();
  files = new Map<string, string>();
  saved = new Map<string, { name: string; status: string; sourceSandboxId: string; createdAt: string }>();
  requests: Recorded[] = [];
  commands: Array<{ sandboxId: string; command: string; timeoutSeconds: number }> = [];
  faults = new Map<string, Fault>();
  commandScript: (command: string, stdin: string | null) => Array<Record<string, unknown>> = () => [
    { type: "started" },
    { type: "stdout", data: "ok\n" },
    { type: "exit", exitCode: 0, timedOut: false },
  ];
  limits: Record<string, unknown> = {
    ok: true,
    accessTier: "trial",
    sandboxPlanKey: "trial",
    billingStatus: "trialing",
    canStart: true,
    checkoutRequired: false,
    activeSandboxes: 0,
    maxActiveSandboxes: 2,
    planIncluded: { vmHours: 555, vmHoursRemaining: 500, periodEnd: "2026-11-16T00:00:00.000Z" },
    wallet: { balanceDollars: 0 },
    machineTypes: [
      { type: "small", available: true, reason: null },
      { type: "default", available: true, reason: null },
      { type: "large", available: false, reason: "not during the free trial" },
    ],
  };
  environmentList: Array<Record<string, unknown>> = [];
  deletedCostUsd = 0;
  desktopProvisioning = 0;
  desktopUrl = "https://bx-test.on.boat.dev/stream.html?hostId=1&appId=2&theme=dark#token=secretdesktoptoken";
  trialTtlCap: number | null = 7200;
  nowIso = "2026-11-09T12:00:00.000Z";
  idempotency = new Map<string, FakeSandbox>();
  deleted = new Map<string, FakeSandbox>();
  private next = 0;

  fail(route: string, fault: Fault) {
    this.faults.set(route, fault);
  }

  add(partial: Partial<FakeSandbox> & { name: string }): FakeSandbox {
    this.next += 1;
    const sandbox: FakeSandbox = {
      id: `bx_test${String(this.next).padStart(4, "0")}`,
      state: "ready",
      labels: {},
      type: "small",
      ttlSeconds: 7200,
      archiveAfter: "2026-11-09T14:00:00.000Z",
      stoppedAt: null,
      dataExpiredAt: null,
      costUsd: 0,
      body: {},
      pollsUntilReady: 0,
      pollsUntilArchived: 0,
      ...partial,
    };
    this.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }

  calls(method: string, path: string): Recorded[] {
    return this.requests.filter((request) => request.method === method && request.path === path);
  }

  private view(sandbox: FakeSandbox, cost = false) {
    return {
      id: sandbox.id,
      name: sandbox.name,
      state: sandbox.state,
      labels: sandbox.labels,
      type: sandbox.type,
      vcpu: sandbox.type === "small" ? 2 : 4,
      memoryGB: sandbox.type === "small" ? 4 : 8,
      archiveAfter: sandbox.archiveAfter,
      stoppedAt: sandbox.stoppedAt,
      dataExpiredAt: sandbox.dataExpiredAt,
      desktopAvailable: true,
      desktopUrl: "https://desktop.example/stream.html?token=secretdesktoptoken",
      snapshotAvailable: true,
      snapshotCompletedAt: sandbox.stoppedAt,
      ...(cost ? { cost: { since: "2026-11-01T00:00:00Z", seconds: 1, dollars: sandbox.costUsd } } : {}),
    };
  }

  private error(status: number, code: string, message = code, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    return new Response(
      JSON.stringify({ ok: false, type: "sandbox.error", status, code, message, error: { code, message, status, details: extra }, requestId: "req_1" }),
      { status, headers: { "content-type": "application/json", ...headers } },
    );
  }

  private ok(body: Record<string, unknown>, status = 200) {
    return new Response(JSON.stringify({ ok: true, ...body }), { status, headers: { "content-type": "application/json" } });
  }

  private ttlCheck(ttl: unknown): Response | null {
    if (this.trialTtlCap === null) return null;
    if (ttl === null || (typeof ttl === "number" && ttl > this.trialTtlCap)) {
      return this.error(400, "trial_auto_stop_required", `Set a TTL of 2 hours or less (Authorization: Bearer ${TEST_KEY})`);
    }
    return null;
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    this.requests.push({ method, path, search: url.searchParams, headers, body });
    if (headers.get("authorization") !== `Bearer ${TEST_KEY}`) return this.error(401, "unauthorized");
    const exactKey = `${method} ${path}`;
    const routeKey = this.faults.has(exactKey) ? exactKey : `${method} ${path.replace(/bx_[a-z0-9]+/, ":id")}`;
    const fault = this.faults.get(routeKey);
    if (fault) {
      if (fault.times !== undefined) {
        fault.times -= 1;
        if (fault.times <= 0) this.faults.delete(routeKey);
      }
      return this.error(
        fault.status,
        fault.code,
        fault.message,
        fault.retryable === undefined ? {} : { retryable: fault.retryable },
        fault.retryAfter === undefined ? {} : { "retry-after": String(fault.retryAfter) },
      );
    }
    const match = path.match(/^\/sandboxes\/(bx_[a-z0-9]+)(\/.*)?$/);
    const sandbox = match ? this.sandboxes.get(match[1]!) : undefined;
    const rest = match?.[2] ?? "";

    if (method === "GET" && path === "/limits") return this.ok(this.limits);
    if (method === "GET" && path === "/environments") return this.ok({ ok: true, type: "environments.list", environments: this.environmentList });
    if (method === "GET" && path === "/me") return this.ok({ user: { login: "tester", email: "t@example.com", accountStatus: "active" } });
    if (method === "GET" && path === "/sandboxes") {
      const labels = url.searchParams.getAll("label").map((pair) => pair.split("=") as [string, string]);
      const states = url.searchParams.get("state")?.split(",") ?? null;
      const before = url.searchParams.get("stoppedBefore");
      const include = (url.searchParams.get("include") ?? "").split(",");
      const list = [...this.sandboxes.values()].filter(
        (item) =>
          labels.every(([key, value]) => item.labels[key] === value) &&
          (states === null || states.includes(item.state)) &&
          (before === null || (item.stoppedAt !== null && item.stoppedAt < before)),
      );
      return this.ok({
        type: "sandbox.list",
        sandboxes: list.map((item) => this.view(item, include.includes("cost"))),
        pageInfo: { hasMore: false, nextCursor: null, limit: 200 },
        ...(include.includes("deletedCost") ? { deletedCost: { since: "2026-11-01T00:00:00Z", seconds: 0, dollars: this.deletedCostUsd } } : {}),
      });
    }
    if (method === "POST" && path === "/sandboxes" && headers.get("idempotency-key") && this.idempotency.has(headers.get("idempotency-key")!)) {
      return this.ok({ type: "sandbox.created", sandbox: this.view(this.idempotency.get(headers.get("idempotency-key")!)!) }, 202);
    }
    if (method === "POST" && path === "/sandboxes") {
      const ttl = body !== null && "ttlSeconds" in body ? body.ttlSeconds : 3600;
      const refused = this.ttlCheck(ttl);
      if (refused) return refused;
      if (typeof body?.from === "string" && !this.saved.has(body.from)) return this.error(404, "snapshot_not_found");
      const created = this.add({
        name: String(body?.name ?? "Sandbox"),
        state: "provisioning",
        labels: (body?.labels as Record<string, string>) ?? {},
        type: String(body?.type ?? "default"),
        ttlSeconds: ttl as number | null,
        body: body ?? {},
        pollsUntilReady: 1,
      });
      const key = headers.get("idempotency-key");
      if (key) this.idempotency.set(key, created);
      return this.ok({ type: "sandbox.created", sandbox: this.view(created) }, 202);
    }
    if (match && !sandbox) return this.error(404, "not_found");
    if (sandbox && method === "GET" && rest === "") {
      if (sandbox.state === "provisioning" || sandbox.state === "resuming") {
        if (sandbox.pollsUntilReady <= 0) sandbox.state = "ready";
        else sandbox.pollsUntilReady -= 1;
      }
      if (sandbox.state === "archiving") {
        if (sandbox.pollsUntilArchived <= 0) {
          sandbox.state = "archived";
          sandbox.stoppedAt = this.nowIso;
        } else sandbox.pollsUntilArchived -= 1;
      }
      return this.ok({ type: "sandbox.info", sandbox: this.view(sandbox) });
    }
    if (sandbox && method === "PATCH" && rest === "") {
      const refused = this.ttlCheck(body?.ttlSeconds);
      if (refused) return refused;
      sandbox.ttlSeconds = (body?.ttlSeconds as number | null) ?? null;
      sandbox.archiveAfter = sandbox.ttlSeconds === null ? null : "2026-11-09T16:00:00.000Z";
      return this.ok({ type: "sandbox.info", sandbox: this.view(sandbox) });
    }
    if (sandbox && method === "DELETE" && rest === "") {
      if (headers.get("x-ascii-confirm-delete") !== sandbox.id) return this.error(400, "confirm_required");
      this.sandboxes.delete(sandbox.id);
      this.deleted.set(sandbox.id, sandbox);
      return this.ok({ type: "sandbox.deleting", operation: { id: "bdop_1", status: "pending" } }, 202);
    }
    if (sandbox && method === "POST" && rest === "/stop") {
      if (sandbox.state !== "archived") sandbox.state = "archiving";
      return this.ok({ type: "sandbox.stopping", id: sandbox.id, status: "archiving" }, 202);
    }
    if (sandbox && method === "POST" && rest === "/resume") {
      if (sandbox.dataExpiredAt !== null) return this.error(409, "snapshot_data_expired");
      const refused = body?.ttlSeconds === undefined ? null : this.ttlCheck(body.ttlSeconds);
      if (refused) return refused;
      sandbox.state = "provisioning";
      sandbox.pollsUntilReady = 1;
      sandbox.stoppedAt = null;
      if (typeof body?.type === "string") sandbox.type = body.type;
      if (body?.ttlSeconds !== undefined) sandbox.ttlSeconds = body.ttlSeconds as number | null;
      return this.ok({ type: "sandbox.resuming", id: sandbox.id, status: "resuming" }, 202);
    }
    if (sandbox && method === "PUT" && rest === "/files") {
      const content = Buffer.from(String(body?.content ?? ""), body?.encoding === "base64" ? "base64" : "utf8").toString("utf8");
      this.files.set(`${sandbox.id}:${body?.path}`, content);
      return this.ok({ type: "file.written" });
    }
    if (sandbox && method === "DELETE" && rest === "/files") {
      this.files.delete(`${sandbox.id}:${url.searchParams.get("path")}`);
      return this.ok({ type: "file.deleted" });
    }
    if (sandbox && method === "POST" && rest === "/desktop") {
      if (this.desktopProvisioning > 0) {
        this.desktopProvisioning -= 1;
        return this.ok({ type: "desktop.provisioning", provisioning: true, message: "Preparing desktop" });
      }
      return this.ok({ type: "desktop.url", success: true, desktopUrl: this.desktopUrl, mode: "moonlight" });
    }
    if (sandbox && method === "POST" && rest === "/commands") {
      const command = String(body?.command ?? "");
      this.commands.push({ sandboxId: sandbox.id, command, timeoutSeconds: Number(body?.timeoutSeconds) });
      const stdinPath = command.match(/\/tmp\/\.bb-boat-stdin-[0-9a-f-]+/)?.[0] ?? null;
      const stdin = stdinPath === null ? null : (this.files.get(`${sandbox.id}:${stdinPath}`) ?? null);
      const frames = this.commandScript(command, stdin);
      if (stdinPath !== null && frames.some((frame) => frame.type === "stdout" || frame.type === "exit")) {
        this.files.delete(`${sandbox.id}:${stdinPath}`);
      }
      return new Response(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n", {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    }
    if (method === "GET" && path.startsWith("/saved-snapshots/")) {
      const name = decodeURIComponent(path.slice("/saved-snapshots/".length));
      const saved = this.saved.get(name);
      return saved ? this.ok({ type: "saved_snapshot.info", snapshot: saved }) : this.error(404, "snapshot_not_found");
    }
    if (method === "DELETE" && path.startsWith("/saved-snapshots/")) {
      const name = decodeURIComponent(path.slice("/saved-snapshots/".length));
      return this.saved.delete(name) ? this.ok({ type: "saved_snapshot.deleted" }) : this.error(404, "snapshot_not_found");
    }
    if (method === "POST" && path === "/saved-snapshots") {
      const name = String(body?.name);
      this.saved.set(name, { name, status: "ready", sourceSandboxId: String(body?.sandboxId), createdAt: this.nowIso });
      return this.ok({ type: "saved_snapshot.saving" }, 202);
    }
    if (method === "DELETE" && path.startsWith("/snapshots/")) return this.ok({ type: "snapshot.deleting" }, 202);
    return this.error(404, "not_found", `no fake route for ${method} ${path}`);
  };
}
