import type { MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { readSandboxResource, type MachineLoginReport } from "@wy3z/bb-suite/machine-backend/server";
import { redactBoat, type BoatApi, type BoatEnvironment, type BoatSandbox } from "./api.ts";
import { DISPLAY_NAME, PROVIDER_ID } from "./backend.ts";
import { SYSTEMCTL_ENV } from "./desktop.ts";
import { execInSandbox } from "./exec.ts";
import type { BoatSettings } from "./settings.ts";

export const AGENT_LOGINS = ["claude", "codex", "opencode"] as const;
export const LOGIN_VARIABLES = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CHATGPT_ACCOUNT_ID", "OPENCODE_API_KEY"] as const;
export const DAEMON_UNITS = "bb-host-daemon-*.service";
export const AGENT_PROCESSES = ["claude", "codex", "pi", "opencode", "cursor-agent"] as const;
export const LOGIN_FOR_PROVIDER: Readonly<Record<string, (typeof AGENT_LOGINS)[number]>> = {
  "claude-code": "claude",
  codex: "codex",
  "acp-opencode": "opencode",
  pi: "opencode",
};
export const BUSY_AWK = `{ parent[$1] = $2; name[$1] = $3 } END { for (p in parent) { if (name[p] !~ /^(${AGENT_PROCESSES.join("|")})$/) continue; q = parent[p]; n = 0; while ((q in parent) && q != root && q > 1 && n++ < 64) q = parent[q]; if (q == root) { print "busy"; exit } } }`;
const FOUND_MS = 5 * 60_000;
const ENVIRONMENTS_MS = 60_000;
const PROBE_MS = 15_000;

const DAEMON_PIDS = [
  "daemon_pids() {",
  `  for u in $(systemctl --user list-units --plain --no-legend --state=active '${DAEMON_UNITS}' 2>/dev/null | awk '{print $1}'); do`,
  '    systemctl --user show -p MainPID --value "$u" 2>/dev/null',
  "  done",
  '  pgrep -u "$(id -u)" -f "[.]bb-machines/" 2>/dev/null',
  "}",
];

export const STALE_FN = [
  "stale_for() {",
  '  local env="/proc/$1/environ" n dv',
  "  for n in $have; do",
  `    dv="$(tr '\\0' '\\n' < "$env" 2>/dev/null | grep -m1 "^$n=" | cut -d= -f2-)"`,
  '    if [ -z "$dv" ] || [ "$dv" != "${!n}" ]; then echo stale; return; fi',
  "  done",
  "  for n in $gone; do",
  `    if tr '\\0' '\\n' < "$env" 2>/dev/null | grep -q "^$n="; then echo stale; return; fi`,
  "  done",
  "}",
].join("\n");

export function shareLoginsScript(restart: boolean): string {
  return [
    "set -u",
    SYSTEMCTL_ENV,
    ...(restart
      ? [
          "for i in $(seq 1 20); do systemctl --user show-environment >/dev/null 2>&1 && break; sleep 1; done",
          "timeout 15 systemctl --user is-system-running --wait >/dev/null 2>&1 || true",
        ]
      : []),
    "systemctl --user show-environment >/dev/null 2>&1 || { echo 'logins: no systemd user manager'; exit 0; }",
    'have=""',
    'gone=""',
    `for n in ${LOGIN_VARIABLES.join(" ")}; do`,
    '  if [ -n "${!n:-}" ]; then have="$have $n"; else gone="$gone $n"; fi',
    "done",
    '[ -n "$have" ] && systemctl --user import-environment $have',
    '[ -n "$gone" ] && systemctl --user unset-environment $gone',
    STALE_FN,
    'restarted=""',
    'kept=""',
    `for u in $(systemctl --user list-units --plain --no-legend --state=active '${DAEMON_UNITS}' 2>/dev/null | awk '{print $1}'); do`,
    '  p="$(systemctl --user show -p MainPID --value "$u" 2>/dev/null)"',
    '  [ -n "$p" ] && [ "$p" != 0 ] && [ -r "/proc/$p/environ" ] || continue',
    '  [ -n "$(stale_for "$p")" ] || continue',
    ...(restart
      ? [
          `  if [ -n "$(ps -eo pid=,ppid=,comm= | awk -v root="$p" '${BUSY_AWK}')" ]; then kept="$kept $u"; continue; fi`,
          '  systemctl --user restart "$u" && restarted="$restarted $u"',
        ]
      : ['  kept="$kept $u"']),
    "done",
    'echo "logins:$have"',
    'echo "restarted:$restarted"',
    'echo "kept:$kept"',
  ].join("\n");
}

export const LOGIN_PROBE = [
  "set -u",
  SYSTEMCTL_ENV,
  ...DAEMON_PIDS,
  'c=""',
  'x=""',
  'o=""',
  '[ -s "$HOME/.claude/.credentials.json" ] && c=1',
  '[ -s "$HOME/.codex/auth.json" ] && x=1',
  '[ -s "$HOME/.local/share/opencode/auth.json" ] && o=1',
  "for p in $(daemon_pids | sort -u); do",
  '  [ "$p" = 0 ] && continue',
  '  [ "$p" = "$$" ] && continue',
  '  [ -r "/proc/$p/environ" ] || continue',
  "  tr '\\0' '\\n' < \"/proc/$p/environ\" 2>/dev/null | grep -Eq '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=.' && c=1",
  "  tr '\\0' '\\n' < \"/proc/$p/environ\" 2>/dev/null | grep -Eq '^OPENCODE_API_KEY=.' && o=1",
  "done",
  '[ -n "$c" ] && echo login:claude',
  '[ -n "$x" ] && echo login:codex',
  '[ -n "$o" ] && echo login:opencode',
  "exit 0",
].join("\n");

const UNIT_NAME = /^bb-host-daemon-[A-Za-z0-9_.@-]{1,120}\.service$/;

type VmApi = Pick<BoatApi, "runCommand" | "writeFile" | "deleteFile">;

async function runOnVm(api: VmApi, sandboxId: string, command: string[], what: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
  let output = "";
  const { exitCode } = await execInSandbox({ api }, sandboxId, {
    command,
    timeoutMs,
    signal,
    stdin: "",
    onOutput: (chunk) => {
      if (output.length < 4_096) output += chunk;
    },
  });
  if (exitCode !== 0) throw new Error(`${what} on ${sandboxId} exited with ${exitCode}`);
  return output;
}

function field(output: string, name: string): string[] | null {
  const line = output.split("\n").find((entry) => entry.startsWith(`${name}:`));
  return line === undefined ? null : line.slice(name.length + 1).trim().split(/\s+/).filter(Boolean);
}

export interface SharedLogins {
  message: string;
  variables: string[];
}

export async function shareLogins(api: VmApi, sandboxId: string, restart: boolean, signal: AbortSignal): Promise<SharedLogins> {
  const output = await runOnVm(api, sandboxId, ["bash", "-c", shareLoginsScript(restart)], "the login hand-off", 60_000, signal);
  if (output.includes("no systemd user manager")) {
    return { message: `${DISPLAY_NAME}: no systemd user manager on ${sandboxId}, so BB's daemon gets no agent logins from boat`, variables: [] };
  }
  const logins = field(output, "logins");
  if (logins === null) throw new Error("the login hand-off printed nothing");
  const variables = (LOGIN_VARIABLES as readonly string[]).filter((name) => logins.includes(name));
  const restarted = (field(output, "restarted") ?? []).filter((unit) => UNIT_NAME.test(unit));
  const kept = (field(output, "kept") ?? []).filter((unit) => UNIT_NAME.test(unit));
  const message = [
    `${DISPLAY_NAME}: agent logins from boat for BB's daemon: ${variables.length === 0 ? "none" : variables.join(", ")}`,
    restarted.length > 0 ? `; restarted ${restarted.join(", ")} to pick them up` : "",
    kept.length > 0 ? `; ${kept.join(", ")} keeps its old logins until it is suspended and resumed` : "",
  ].join("");
  return { message, variables };
}

export function parseLogins(output: string): string[] {
  const found = new Set<string>();
  for (const line of output.split("\n")) {
    const match = /^login:([a-z]+)$/.exec(line.trim());
    if (match && (AGENT_LOGINS as readonly string[]).includes(match[1]!)) found.add(match[1]!);
  }
  return AGENT_LOGINS.filter((login) => found.has(login));
}

export function environmentNote(name: string, environment: BoatEnvironment | null): string | null {
  if (name === "") {
    return `${DISPLAY_NAME}'s boat environment setting is empty, so boat gives its VMs no agent logins. Name a boat environment that passes Agents credentials under Settings → Plugins → ${DISPLAY_NAME}`;
  }
  if (environment === null) return `boat has no environment named "${name}". Create it on boat.dev or fix ${DISPLAY_NAME}'s boat environment setting`;
  if (environment.safeForThirdParties) {
    return `boat environment "${name}" is Safe for third parties, which withholds agent logins. Turn that off for VMs only you use`;
  }
  if (!environment.passAgentsCredentials) {
    return `boat environment "${name}" has Agents credentials off. Turn it on in that environment`;
  }
  return null;
}

export function sandboxEnvironmentNote(label: string, vm: Pick<BoatSandbox, "environment" | "environmentVersion">, environment: BoatEnvironment | null): string | null {
  if (vm.environment === null) {
    return `${label} was created without a boat environment, so boat gives it no agent logins. Delete it and start the thread on a new VM`;
  }
  if (environment === null) return `${label} uses boat environment "${vm.environment}", which no longer exists. Delete it and start the thread on a new VM`;
  if (vm.environmentVersion === null || environment.latestVersionNumber === null || vm.environmentVersion !== environment.latestVersionNumber) {
    return `${label} is on version ${vm.environmentVersion ?? "unknown"} of boat environment "${vm.environment}" (latest ${environment.latestVersionNumber ?? "unknown"}), so its switches can't be read. Run boat env upgrade ${vm.environment}, or delete the VM`;
  }
  return environmentNote(vm.environment, environment);
}

export interface LoginCheckDeps {
  api: Pick<BoatApi, "environments" | "getSandbox" | "runCommand" | "writeFile" | "deleteFile">;
  settings: () => Promise<Pick<BoatSettings, "environment">>;
  resource: (hostId: string) => Promise<unknown>;
  now?: () => number;
}

export function createBoatLoginCheck(deps: LoginCheckDeps): (context: MessageDispatchHookContext, signal: AbortSignal) => Promise<MachineLoginReport> {
  const now = deps.now ?? Date.now;
  const found = new Map<string, Map<string, number>>();
  let environments: { at: number; value: BoatEnvironment[] } | null = null;

  async function listEnvironments(signal: AbortSignal): Promise<BoatEnvironment[]> {
    if (environments !== null && now() - environments.at < ENVIRONMENTS_MS) return environments.value;
    let value: BoatEnvironment[];
    try {
      value = await deps.api.environments(signal);
    } catch (error) {
      throw new Error(`couldn't read boat's environments: ${redactBoat(error instanceof Error ? error.message : String(error))}`);
    }
    environments = { at: now(), value };
    return value;
  }

  async function environmentNamed(name: string, signal: AbortSignal): Promise<BoatEnvironment | null> {
    return (await listEnvironments(signal)).find((entry) => entry.name === name) ?? null;
  }

  async function sandboxOf(context: MessageDispatchHookContext): Promise<{ id: string; label: string; active: boolean } | null> {
    const host = context.host;
    if (host === null || host.machineProviderId !== PROVIDER_ID) return null;
    const raw = await deps.resource(host.id);
    if (raw === null || raw === undefined) return null;
    const sandboxId = readSandboxResource(raw).sandboxId;
    return sandboxId === null ? null : { id: sandboxId, label: host.name ?? host.id, active: host.lifecycle?.phase === "active" };
  }

  function fresh(sandboxId: string): string[] {
    const seen = found.get(sandboxId);
    if (seen === undefined) return [];
    return AGENT_LOGINS.filter((login) => now() - (seen.get(login) ?? -Infinity) < FOUND_MS);
  }

  async function probe(sandboxId: string, signal: AbortSignal): Promise<string[]> {
    const logins = parseLogins(await runOnVm(deps.api, sandboxId, ["sh", "-c", LOGIN_PROBE], "the login check", PROBE_MS, signal));
    found.set(sandboxId, new Map(logins.map((login) => [login, now()])));
    return logins;
  }

  async function missingNote(sandbox: { id: string; label: string }, logins: string[], signal: AbortSignal): Promise<string> {
    const what = `${sandbox.label} has ${logins.length === 0 ? "no agent login" : `only a ${logins.join(" and ")} login`} from boat`;
    let vm: BoatSandbox | null = null;
    try {
      vm = await deps.api.getSandbox(sandbox.id, signal);
    } catch {
      vm = null;
    }
    if (vm !== null && vm.environment === null) return `${what}: it was created without a boat environment. Delete it and start the thread on a new VM`;
    const name = vm?.environment ?? "its boat environment";
    return `${what}. Connect the agent on boat.dev (Agents & Proxying) and make sure ${vm === null ? name : `"${name}"`} passes Agents credentials (run boat env upgrade if you changed it), then suspend and resume ${sandbox.label} so BB's daemon picks the login up`;
  }

  return async (context, signal) => {
    const want = LOGIN_FOR_PROVIDER[context.requestedExecution?.providerId ?? ""];
    const sandbox = await sandboxOf(context);
    if (sandbox !== null && sandbox.active) {
      const cached = fresh(sandbox.id);
      if (want !== undefined && cached.includes(want)) return { logins: cached, note: null };
      const logins = await probe(sandbox.id, signal);
      const enough = want === undefined ? logins.length === AGENT_LOGINS.length : logins.includes(want);
      return { logins, note: enough ? null : await missingNote(sandbox, logins, signal) };
    }
    if (sandbox !== null) {
      const vm = await deps.api.getSandbox(sandbox.id, signal);
      const environment = vm.environment === null ? null : await environmentNamed(vm.environment, signal);
      const note = sandboxEnvironmentNote(sandbox.label, vm, environment);
      return note === null ? { logins: [...AGENT_LOGINS], note: null } : { logins: [], note };
    }
    const name = (await deps.settings()).environment.trim();
    const environment = name === "" ? null : await environmentNamed(name, signal);
    const note = environmentNote(name, environment);
    return note === null ? { logins: [...AGENT_LOGINS], note: null } : { logins: [], note };
  };
}
