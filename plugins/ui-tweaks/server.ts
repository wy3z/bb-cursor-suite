import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  PREFERENCES_KV_KEY,
  preferencesRpcContract,
} from "./lib/preferences-rpc.js";

export default function plugin(bb: BbPluginApi) {
  bb.rpc.register(preferencesRpcContract, {
    async getPreferences() {
      const stored = await bb.storage.kv.get<Record<string, unknown>>(
        PREFERENCES_KV_KEY,
      );
      return { preferences: stored ?? null };
    },
    async setPreferences({ preferences }) {
      await bb.storage.kv.set(PREFERENCES_KV_KEY, preferences);
      return { ok: true as const };
    },
  });
  bb.log.info("loaded");
}
