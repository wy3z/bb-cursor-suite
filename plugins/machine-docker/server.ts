import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createCloudLaunchCheck, registerSandboxBackend } from "@wy3z/bb-suite/machine-backend/server";
import { PROVIDER_ID, createDockerBackend } from "./lib/backend.ts";
import { chainDispatchChecks, createProviderCliCheck } from "./lib/cli-check.ts";
import { createDockerRunner } from "./lib/docker.ts";
import { parseDefaultGateway } from "./lib/egress-probe.ts";
import { policyFrom, readDockerSettings, settingDescriptors } from "./lib/settings.ts";

async function hostFacts() {
  const hostAddresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  const lanGateway = await readFile("/proc/net/route", "utf8").then(parseDefaultGateway, () => null);
  return { hostAddresses, lanGateway };
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define(settingDescriptors);
  const current = async () => readDockerSettings(await settings.get());
  const backend = createDockerBackend({ docker: createDockerRunner(), settings: current, hostFacts });
  registerSandboxBackend(bb, backend, async () => policyFrom(await current()), {
    scheduleName: "docker-sandbox-sweep",
    launchCheck: false,
  });
  bb.experimental_hooks.on(
    "message.dispatch",
    chainDispatchChecks([createCloudLaunchCheck(bb, PROVIDER_ID), createProviderCliCheck(bb, PROVIDER_ID)]),
  );
}
