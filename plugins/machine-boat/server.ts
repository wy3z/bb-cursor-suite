import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerSandboxBackend } from "@wy3z/bb-suite/machine-backend/server";
import { createBoatApi } from "./lib/api.ts";
import { DISPLAY_NAME, createBoatBackend } from "./lib/backend.ts";
import { createBoatService, registerBoatRpcAndCli } from "./lib/rpc.ts";
import { policyFrom, readBoatSettings, settingDescriptors } from "./lib/settings.ts";

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define(settingDescriptors);
  const current = async () => readBoatSettings(await settings.get());
  const api = createBoatApi({ apiKey: async () => (await current()).apiKey });
  const backend = createBoatBackend({ api, settings: current, log: bb.log });
  const registration = registerSandboxBackend(bb, backend, async () => policyFrom(await current()), {
    scheduleName: "boat-sandbox-sweep",
  });
  bb.background.schedule("boat-sandbox-keep", "41 4 * * *", async () => {
    try {
      await backend.keepStopped();
    } catch (error) {
      bb.log.warn(`${DISPLAY_NAME}: the 14-day keep check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  registerBoatRpcAndCli(
    bb,
    createBoatService({
      backend,
      registration,
      settings: current,
      api,
      machines: {
        host: (hostId) => bb.sdk.hosts.get({ hostId }).catch(() => null),
        resource: (hostId) => bb.experimental_machines.getResource(hostId),
      },
    }),
  );
}
