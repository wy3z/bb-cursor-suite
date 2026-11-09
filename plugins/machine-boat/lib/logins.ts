import type { MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { readSandboxResource, type MachineLoginReport } from "@wy3z/bb-suite/machine-backend/server";
import { redactBoat, type BoatApi, type BoatEnvironment } from "./api.ts";
import { DISPLAY_NAME, PROVIDER_ID } from "./backend.ts";
import { SYSTEMCTL_ENV } from "./desktop.ts";
import { execInSandbox } from "./exec.ts";
import type { BoatSettings } from "./settings.ts";

export const AGENT_LOGINS = ["claude", "codex"] as const;
export const LOGIN_VARIABLES = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CHATGPT_ACCOUNT_ID"] as const;
export const DAEMON_UNITS = "bb-host-daemon-*.service";
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

export function shareLoginsScript(restart: boolean): string {
  return [
    "set -u",
    SYSTEMCTL_ENV,
    "systemctl --user show-environment >/dev/null 2>&1 || { echo 'logins: no systemd user manager'; exit 0; }",
    'have=""',
    'gone=""',
    `for n in ${LOGIN_VARIABLES.join(" ")}; do`,
    '  if [ -n "${!n:-}" ]; then have="$have $n"; else gone="$gone $n"; fi',
    "done",
    '[ -n "$have" ] && systemctl --user import-environment $have',
    '[ -n "$gone" ] && systemctl --user unset-environment $gone',
    'restarted=""',
    'kept=""',
    `for u in $(systemctl --user list-units --plain --no-legend --state=active '${DAEMON_UNITS}' 2>/dev/null | awk '{print $1}'); do`,
    '  p="$(systemctl --user show -p MainPID --value "$u" 2>/dev/null)"',
    '  [ -n "$p" ] && [ "$p" != 0 ] && [ -r "/proc/$p/environ" ] || continue',
    `  names="$(tr '\\0' '\\n' < "/proc/$p/environ" | cut -d= -f1)"`,
    '  stale=""',
    '  for n in $have; do printf "%s\\n" "$names" | grep -qx "$n" || stale=1; done',
    '  for n in $gone; do printf "%s\\n" "$names" | grep -qx "$n" && stale=1; done',
    restart
      ? '  if [ -n "$stale" ]; then systemctl --user restart "$u" && restarted="$restarted $u"; fi'
      : '  if [ -n "$stale" ]; then kept="$kept $u"; fi',
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
  '[ -s "$HOME/.claude/.credentials.json" ] && c=1',
  '[ -s "$HOME/.codex/auth.json" ] && x=1',
  "for p in $(daemon_pids | sort -u); do",
  '  [ "$p" = 0 ] && continue',
  '  [ "$p" = "$$" ] && continue',
  '  [ -r "/proc/$p/environ" ] || continue',
  "  tr '\\0' '\\n' < \"/proc/$p/environ\" 2>/dev/null | grep -Eq '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=.' && c=1",
  "done",
  '[ -n "$c" ] && echo login:claude',
  '[ -n "$x" ] && echo login:codex',
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

export async function shareLogins(
  api: VmApi,
  sandboxId: string,
  restart: boolean,
  signal: AbortSignal,
): Promise<string> {
  const output = await runOnVm(api, sandboxId, ["bash", "-c", shareLoginsScript(restart)], "the login hand-off", 30_000, signal);
  if (output.includes("no systemd user manager")) return `${DISPLAY_NAME}: no systemd user manager on ${sandboxId}, so boat's agent logins stay with boat's own commands`;
  const logins = field(output, "logins");
  if (logins === null) throw new Error("the login hand-off printed nothing");
  const names = (LOGIN_VARIABLES as readonly string[]).filter((name) => logins.includes(name));
  const restarted = (field(output, "restarted") ?? []).filter((unit) => UNIT_NAME.test(unit));
  const kept = (field(output, "kept") ?? []).filter((unit) => UNIT_NAME.test(unit));
  return [
    `${DISPLAY_NAME}: agent logins from boat for BB's daemon: ${names.length === 0 ? "none" : names.join(", ")}`,
    restarted.length > 0 ? `; restarted ${restarted.join(", ")} to pick them up` : "",
    kept.length > 0 ? `; ${kept.join(", ")} keeps its old logins until the next resume` : "",
  ].join("");
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
  if (environment.safeForThirdParties && !environment.proxyAiCredentials) {
    return `boat environment "${name}" is Safe for third parties, which withholds agent logins. Turn that off for VMs only you use, or turn on AI credentials proxying`;
  }
  if (!environment.safeForThirdParties && !environment.passAgentsCredentials) {
    return `boat environment "${name}" has Agents credentials off. Turn it on in that environment`;
  }
  return null;
}

export interface LoginCheckDeps {
  api: Pick<BoatApi, "environments" | "runCommand" | "writeFile" | "deleteFile">;
  settings: () => Promise<Pick<BoatSettings, "environment">>;
  resource: (hostId: string) => Promise<unknown>;
  now?: () => number;
}

export function createBoatLoginCheck(deps: LoginCheckDeps): (context: MessageDispatchHookContext, signal: AbortSignal) => Promise<MachineLoginReport> {
  const now = deps.now ?? Date.now;
  const found = new Map<string, number>();
  let environments: { at: number; value: BoatEnvironment[] } | null = null;

  async function listEnvironments(signal: AbortSignal): Promise<BoatEnvironment[]> {
    if (environments !== null && now() - environments.at < ENVIRONMENTS_MS) return environments.value;
    const value = await deps.api.environments(signal);
    environments = { at: now(), value };
    return value;
  }

  async function sandboxOf(context: MessageDispatchHookContext): Promise<{ id: string; label: string } | null> {
    const host = context.host;
    if (host === null || host.machineProviderId !== PROVIDER_ID || host.lifecycle?.phase !== "active") return null;
    const raw = await deps.resource(host.id);
    if (raw === null || raw === undefined) return null;
    const sandboxId = readSandboxResource(raw).sandboxId;
    return sandboxId === null ? null : { id: sandboxId, label: host.name ?? host.id };
  }

  async function probe(sandboxId: string, signal: AbortSignal): Promise<string[]> {
    return parseLogins(await runOnVm(deps.api, sandboxId, ["sh", "-c", LOGIN_PROBE], "the login check", PROBE_MS, signal));
  }

  return async (context, signal) => {
    const sandbox = await sandboxOf(context);
    if (sandbox !== null) {
      const cached = found.get(sandbox.id);
      if (cached !== undefined && now() - cached < FOUND_MS) return { logins: [...AGENT_LOGINS], note: null };
      const logins = await probe(sandbox.id, signal);
      if (logins.length === AGENT_LOGINS.length) {
        found.set(sandbox.id, now());
        return { logins, note: null };
      }
      found.delete(sandbox.id);
      return {
        logins,
        note: `${sandbox.label} has ${logins.length === 0 ? "no agent login" : `only a ${logins.join(" and ")} login`} from boat. Connect the agent on boat.dev (Agents & Proxying), then run boat env upgrade so this VM gets it`,
      };
    }
    const name = (await deps.settings()).environment.trim();
    let environment: BoatEnvironment | null = null;
    if (name !== "") {
      try {
        environment = (await listEnvironments(signal)).find((entry) => entry.name === name) ?? null;
      } catch (error) {
        throw new Error(`couldn't read boat environment "${name}": ${redactBoat(error instanceof Error ? error.message : String(error))}`);
      }
    }
    const note = environmentNote(name, environment);
    return note === null ? { logins: [...AGENT_LOGINS], note: null } : { logins: [], note };
  };
}
