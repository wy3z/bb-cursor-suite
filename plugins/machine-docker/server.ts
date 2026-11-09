import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createCloudLaunchCheck, registerSandboxBackend } from "@wy3z/bb-suite/machine-backend/server";
import { PROVIDER_ID, createDockerBackend } from "./lib/backend.ts";
import { chainDispatchChecks, createProviderCliCheck } from "./lib/cli-check.ts";
import { createDockerRunner } from "./lib/docker.ts";
import { policyFrom, readDockerSettings, settingDescriptors } from "./lib/settings.ts";

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define(settingDescriptors);
  const current = async () => readDockerSettings(await settings.get());
  const backend = createDockerBackend({ docker: createDockerRunner(), settings: current });
  registerSandboxBackend(bb, backend, async () => policyFrom(await current()), {
    scheduleName: "docker-sandbox-sweep",
    launchCheck: false,
  });
  bb.experimental_hooks.on(
    "message.dispatch",
    chainDispatchChecks([createCloudLaunchCheck(bb, PROVIDER_ID), createProviderCliCheck(bb, PROVIDER_ID)]),
  );
}
