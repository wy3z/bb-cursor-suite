import { describe, expect, test } from "bun:test";
import { CLOSED_PORT, isPrivateIPv4, parseDefaultGateway, parsePublishedPorts, probeTargets, reachabilityMessage } from "../lib/egress-probe.ts";

describe("egress probe", () => {
  test("classifies private, link-local and CGNAT IPv4", () => {
    for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.212", "169.254.1.1", "100.64.0.1", "100.127.255.255"]) expect(isPrivateIPv4(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "100.128.0.1", "104.26.3.132", "not-an-ip"]) expect(isPrivateIPv4(ip)).toBe(false);
  });

  test("parses published host ports and skips loopback bindings", () => {
    const ports = parsePublishedPorts("0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp\n127.0.0.1:39471->80/tcp\n192.168.1.212:8080-8081->80-81/tcp\n0.0.0.0:53->53/udp");
    expect(ports).toEqual([
      { ip: "0.0.0.0", port: 5433 },
      { ip: "192.168.1.212", port: 8080 },
      { ip: "192.168.1.212", port: 8081 },
    ]);
  });

  test("reads the default gateway from /proc/net/route", () => {
    const route = "Iface\tDestination\tGateway\tFlags\nwlan0\t00000000\t0101A8C0\t0003\nwlan0\t0001A8C0\t00000000\t0001";
    expect(parseDefaultGateway(route)).toBe("192.168.1.1");
    expect(parseDefaultGateway("Iface\tDestination\tGateway\n")).toBeNull();
  });

  test("probes the gateway, host addresses, published ports and the LAN router", () => {
    const targets = probeTargets({
      gateway: "10.213.89.1",
      hostAddresses: ["192.168.1.212", "8.8.4.4"],
      publishedPorts: [{ ip: "0.0.0.0", port: 5433 }],
      lanGateway: "192.168.1.1",
    });
    const keys = targets.map((target) => `${target.host}:${target.port}`);
    expect(keys).toContain(`10.213.89.1:${CLOSED_PORT}`);
    expect(keys).toContain(`192.168.1.212:${CLOSED_PORT}`);
    expect(keys).toContain("10.213.89.1:5433");
    expect(keys).toContain("192.168.1.212:5433");
    expect(keys).toContain("192.168.1.1:443");
    expect(keys.some((key) => key.startsWith("8.8.4.4"))).toBe(false);
  });

  test("a clean probe gives no message; a reachable one names what answered", () => {
    expect(reachabilityMessage([], "10.213.89.0/24")).toBeNull();
    const message = reachabilityMessage([{ host: "192.168.1.1", port: 443, why: "the LAN router" }], "10.213.89.0/24")!;
    expect(message).toContain("the LAN router at 192.168.1.1:443");
    expect(message).toContain("blocked");
  });
});
