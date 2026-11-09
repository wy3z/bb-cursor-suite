export interface ProbeTarget {
  host: string;
  port: number;
  why: string;
}

export interface ProbeFacts {
  gateway: string;
  hostAddresses: string[];
  publishedPorts: Array<{ ip: string; port: number }>;
  lanGateway: string | null;
}

export const CLOSED_PORT = 9;
export const MAX_TARGETS = 48;
const LAN_PORTS = [53, 80, 443];

export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

export function parsePublishedPorts(psOutput: string): Array<{ ip: string; port: number }> {
  const out = new Map<string, { ip: string; port: number }>();
  for (const match of psOutput.matchAll(/(\d{1,3}(?:\.\d{1,3}){3}):(\d+)(?:-(\d+))?->\d+(?:-\d+)?\/tcp/g)) {
    const ip = match[1]!;
    if (ip.startsWith("127.")) continue;
    const first = Number(match[2]);
    const last = match[3] === undefined ? first : Math.min(Number(match[3]), first + 3);
    for (let port = first; port <= last; port += 1) out.set(`${ip}:${port}`, { ip, port });
  }
  return [...out.values()];
}

export function parseDefaultGateway(procNetRoute: string): string | null {
  for (const line of procNetRoute.split("\n").slice(1)) {
    const [, destination, gateway] = line.trim().split(/\s+/);
    if (destination !== "00000000" || gateway === undefined || !/^[0-9A-F]{8}$/i.test(gateway)) continue;
    const bytes = gateway.match(/../g)!.map((pair) => parseInt(pair, 16)).reverse();
    const ip = bytes.join(".");
    if (ip !== "0.0.0.0") return ip;
  }
  return null;
}

export function probeTargets(facts: ProbeFacts): ProbeTarget[] {
  const targets = new Map<string, ProbeTarget>();
  const add = (host: string, port: number, why: string) => {
    const key = `${host}:${port}`;
    if (!targets.has(key)) targets.set(key, { host, port, why });
  };
  const hosts = [...new Set([facts.gateway, ...facts.hostAddresses.filter(isPrivateIPv4)])];
  for (const host of hosts) add(host, CLOSED_PORT, host === facts.gateway ? "the sandbox network's gateway (the host)" : "the host's address");
  for (const { ip, port } of facts.publishedPorts) {
    const where = ip === "0.0.0.0" ? hosts : isPrivateIPv4(ip) ? [ip] : [];
    for (const host of where) add(host, port, "a port another container publishes on the host");
  }
  if (facts.lanGateway !== null && isPrivateIPv4(facts.lanGateway) && !hosts.includes(facts.lanGateway)) {
    for (const port of LAN_PORTS) add(facts.lanGateway, port, "the LAN router");
  }
  return [...targets.values()].slice(0, MAX_TARGETS);
}

export const PROBE_SCRIPT = `
const net = require("node:net");
const targets = JSON.parse(process.argv[1]);
const one = (t) => new Promise((resolve) => {
  const socket = net.connect({ host: t.host, port: t.port });
  const done = (reachable) => { socket.destroy(); resolve({ ...t, reachable }); };
  socket.setTimeout(1500, () => done(false));
  socket.once("connect", () => done(true));
  socket.once("error", (error) => done(error.code === "ECONNREFUSED" || error.code === "ECONNRESET"));
});
Promise.all(targets.map(one)).then((results) => process.stdout.write(JSON.stringify(results.filter((r) => r.reachable))));
`;

export function reachabilityMessage(reachable: ProbeTarget[], subnet: string): string | null {
  if (reachable.length === 0) return null;
  const sample = reachable.slice(0, 3).map((target) => `${target.why} at ${target.host}:${target.port}`).join("; ");
  return `Docker Sandbox: a sandbox on ${subnet} can reach your host or private network (${sample}${reachable.length > 3 ? `, and ${reachable.length - 3} more` : ""}), so new sandboxes are blocked. Block that subnet from host and private addresses (see the plugin README, "Host and LAN access"), then check again.`;
}
