import { readSandboxResource } from "@wy3z/bb-suite/machine-backend/server";
import { DESKTOP_URL_MS, isViewUrl, type DesktopHost, type DesktopProbe, type DesktopVendor, type DesktopView } from "@wy3z/bb-suite/desktop/server";
import { BoatApiError, LIVE_STATES, READY_STATES, isNotFound, redactBoat, type BoatApi } from "./api.ts";
import { DISPLAY_NAME, PROVIDER_ID } from "./backend.ts";
import { execInSandbox } from "./exec.ts";

export const STREAM_HOST_SUFFIX = ".on.boat.dev";

export function isBoatStreamUrl(value: string): boolean {
  if (!isViewUrl(value)) return false;
  const host = new URL(value).hostname.toLowerCase();
  return host.endsWith(STREAM_HOST_SUFFIX) && host.length > STREAM_HOST_SUFFIX.length;
}

export function withoutViewerOverlay(url: string): string {
  const hashAt = url.indexOf("#");
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : url.slice(hashAt);
  const queryAt = base.indexOf("?");
  const path = queryAt === -1 ? base : base.slice(0, queryAt);
  const params = queryAt === -1 ? [] : base.slice(queryAt + 1).split("&").filter((pair) => pair !== "" && pair.split("=")[0] !== "overlay");
  return `${path}?${[...params, "overlay=0"].join("&")}${fragment}`;
}

export const COMPUTER_UNIT = "cua-driver.service";
export const RELEASE_UNIT = "bb-desktop-release";
export const CODEX_TOOL_TIMEOUT_SECONDS = 3600;
export const CODEX_TIMEOUT_UNIT = "bb-codex-computer-timeout";
const URL_MARGIN_MS = 30_000;
const PROVISION_ATTEMPTS = 20;

export const SYSTEMCTL_ENV = 'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"; export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"';

export function pauseScript(leaseMs: number): string {
  const seconds = Math.max(30, Math.ceil(leaseMs / 1000) + 30);
  return [
    "set -u",
    SYSTEMCTL_ENV,
    `systemctl --user cat ${COMPUTER_UNIT} >/dev/null 2>&1 || { echo absent; exit 0; }`,
    `systemctl --user stop ${RELEASE_UNIT}.timer ${RELEASE_UNIT}.service >/dev/null 2>&1 || true`,
    `systemctl --user reset-failed ${RELEASE_UNIT}.timer ${RELEASE_UNIT}.service >/dev/null 2>&1 || true`,
    `systemd-run --user --quiet --collect --unit=${RELEASE_UNIT} --on-active=${seconds}s --timer-property=AccuracySec=1s /bin/sh -c ${singleQuote(resumeCommands().join("; "))} || { ${resumeCommands().join("; ")}; exit 3; }`,
    `if [ "$(systemctl --user show -p FreezerState --value ${COMPUTER_UNIT} 2>/dev/null)" = frozen ]; then echo frozen; exit 0; fi`,
    `if systemctl --user freeze ${COMPUTER_UNIT} >/dev/null 2>&1; then echo frozen; exit 0; fi`,
    `systemctl --user kill --signal=SIGSTOP ${COMPUTER_UNIT} || exit 4`,
    "echo stopped",
  ].join("\n");
}

function resumeCommands(): string[] {
  return [
    `systemctl --user thaw ${COMPUTER_UNIT} >/dev/null 2>&1`,
    `systemctl --user kill --signal=SIGCONT ${COMPUTER_UNIT} >/dev/null 2>&1`,
    "true",
  ];
}

export function resumeScript(): string {
  return [
    "set -u",
    SYSTEMCTL_ENV,
    `systemctl --user stop ${RELEASE_UNIT}.timer ${RELEASE_UNIT}.service >/dev/null 2>&1 || true`,
    `systemctl --user cat ${COMPUTER_UNIT} >/dev/null 2>&1 || { echo absent; exit 0; }`,
    ...resumeCommands(),
    "echo running",
  ].join("\n");
}

export const CODEX_PATCH = `#!/bin/sh
f="$HOME/.codex/config.toml"
[ -f "$f" ] || exit 0
tmp="$f.bb-tmp"
awk -v want="tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SECONDS}" '
/^[[:space:]]*\\[/ {
  inside = ($0 ~ /^[[:space:]]*\\[mcp_servers\\.computer\\][[:space:]]*(#.*)?$/)
  print
  if (inside) print want
  next
}
inside && /^[[:space:]]*tool_timeout_sec[[:space:]]*=/ { next }
{ print }
' "$f" > "$tmp" || { rm -f "$tmp"; exit 1; }
if cmp -s "$f" "$tmp"; then rm -f "$tmp"; else cat "$tmp" > "$f" && rm -f "$tmp"; fi
`;

const CODEX_PATH_UNIT = `[Unit]
Description=Give Codex's computer tools a long timeout after boat writes their config

[Path]
PathChanged=%h/.codex/config.toml

[Install]
WantedBy=default.target
`;

const CODEX_SERVICE_UNIT = `[Unit]
Description=Give Codex's computer tools a long timeout
StartLimitIntervalSec=0

[Service]
Type=oneshot
ExecStart=/bin/sh %h/.local/share/bb-boat/codex-computer-timeout.sh
`;

function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function heredoc(path: string, body: string, tag: string): string {
  return `cat > ${path} <<'${tag}'\n${body}${body.endsWith("\n") ? "" : "\n"}${tag}`;
}

export function codexTimeoutScript(): string {
  return [
    "set -eu",
    SYSTEMCTL_ENV,
    'mkdir -p "$HOME/.config/systemd/user" "$HOME/.local/share/bb-boat"',
    heredoc('"$HOME/.local/share/bb-boat/codex-computer-timeout.sh"', CODEX_PATCH, "BB_CODEX_PATCH"),
    heredoc(`"$HOME/.config/systemd/user/${CODEX_TIMEOUT_UNIT}.path"`, CODEX_PATH_UNIT, "BB_CODEX_PATH"),
    heredoc(`"$HOME/.config/systemd/user/${CODEX_TIMEOUT_UNIT}.service"`, CODEX_SERVICE_UNIT, "BB_CODEX_SERVICE"),
    "systemctl --user daemon-reload",
    `systemctl --user enable --now ${CODEX_TIMEOUT_UNIT}.path >/dev/null 2>&1`,
    'sh "$HOME/.local/share/bb-boat/codex-computer-timeout.sh"',
    "echo ok",
  ].join("\n");
}

export interface BoatDesktopDeps {
  api: Pick<BoatApi, "getSandbox" | "desktop" | "runCommand" | "writeFile" | "deleteFile">;
  resource(hostId: string): Promise<unknown>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function text(error: unknown): string {
  return redactBoat(error instanceof Error ? error.message : String(error));
}

export async function runScript(
  deps: Pick<BoatDesktopDeps, "api" | "sleep">,
  sandboxId: string,
  script: string,
  signal: AbortSignal,
  timeoutMs = 60_000,
): Promise<string> {
  let output = "";
  const { exitCode } = await execInSandbox({ api: deps.api, sleep: deps.sleep }, sandboxId, {
    command: ["bash", "-c", script],
    stdin: "",
    timeoutMs,
    signal,
    onOutput: (chunk: string) => {
      if (output.length < 4000) output += chunk;
    },
  });
  const trimmed = redactBoat(output.trim()).slice(-500);
  if (exitCode !== 0) throw new Error(`exit ${exitCode}${trimmed ? `: ${trimmed}` : ""}`);
  return trimmed;
}

export function createBoatDesktop(deps: BoatDesktopDeps): DesktopVendor {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function sandboxIdOf(host: DesktopHost): Promise<string> {
    const raw = await deps.resource(host.hostId);
    if (raw === null || raw === undefined) throw new Error(`${host.hostId} has no recorded boat sandbox yet`);
    const resource = readSandboxResource(raw);
    if (resource.sandboxId === null) throw new Error(`${host.hostId} has no running boat sandbox`);
    return resource.sandboxId;
  }

  return {
    providerId: PROVIDER_ID,
    displayName: DISPLAY_NAME,
    interactive: true,

    async probe(host, signal): Promise<DesktopProbe> {
      const sandboxId = await sandboxIdOf(host);
      let sandbox;
      try {
        sandbox = await deps.api.getSandbox(sandboxId, signal);
      } catch (error) {
        if (isNotFound(error)) return { state: "unavailable", message: "The boat sandbox behind this machine is gone." };
        throw error;
      }
      if (READY_STATES.has(sandbox.state)) {
        return sandbox.desktopAvailable
          ? { state: "ready", message: null }
          : { state: "unavailable", message: "This boat sandbox has no desktop." };
      }
      if (sandbox.state === "archiving" || sandbox.state === "archived") {
        return { state: "stopped", message: "The machine is paused. Resume it to see its desktop." };
      }
      if (LIVE_STATES.has(sandbox.state)) return { state: "starting", message: "The desktop is starting." };
      return { state: "unavailable", message: `The boat sandbox is ${sandbox.state}.` };
    },

    async view(host, { theme, touch, signal }): Promise<DesktopView> {
      const sandboxId = await sandboxIdOf(host);
      for (let attempt = 1; ; attempt += 1) {
        signal.throwIfAborted();
        let answer: { url: string | null; provisioning: boolean } | null = null;
        try {
          answer = await deps.api.desktop(sandboxId, theme, signal);
        } catch (error) {
          const notReady = error instanceof BoatApiError && (error.code === "desktop_not_ready" || error.code === "sandbox_starting");
          if (!notReady || attempt >= PROVISION_ATTEMPTS) throw new Error(text(error));
        }
        if (answer !== null && answer.url !== null && !answer.provisioning) {
          if (!isBoatStreamUrl(answer.url)) throw new Error(`boat.dev answered with a desktop address that isn't an https address on ${STREAM_HOST_SUFFIX.slice(1)}`);
          return { url: touch === true ? answer.url : withoutViewerOverlay(answer.url), expiresAt: now() + DESKTOP_URL_MS - URL_MARGIN_MS };
        }
        if (attempt >= PROVISION_ATTEMPTS) throw new Error("boat.dev is still preparing the desktop; try again in a minute");
        await sleep(2_000);
      }
    },

    async pauseAgent(host, { leaseMs, signal }) {
      const output = await runScript({ api: deps.api, sleep }, await sandboxIdOf(host), pauseScript(leaseMs), signal);
      return !/(^|\n)absent$/.test(output);
    },

    async resumeAgent(host, signal) {
      await runScript({ api: deps.api, sleep }, await sandboxIdOf(host), resumeScript(), signal);
    },
  };
}
