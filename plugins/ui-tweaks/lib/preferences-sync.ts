let pluginId = "ui-tweaks";

export function setPreferencesPluginId(id: string) {
  pluginId = id;
}

async function callRpc(method: string, input: unknown): Promise<unknown> {
  const response = await fetch(
    `/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/${encodeURIComponent(method)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input ?? null),
    },
  );
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    result?: unknown;
  } | null;
  if (!response.ok || body?.ok !== true) {
    throw new Error(`ui-tweaks ${method} failed (${response.status})`);
  }
  return body.result;
}

export async function fetchRemotePreferences(): Promise<Record<
  string,
  unknown
> | null> {
  const result = (await callRpc("getPreferences", null)) as {
    preferences?: unknown;
  } | null;
  const preferences = result?.preferences;
  if (
    typeof preferences !== "object" ||
    preferences === null ||
    Array.isArray(preferences)
  ) {
    return null;
  }
  return preferences as Record<string, unknown>;
}

let pendingPush: Record<string, unknown> | null = null;
let pushing = false;

export function pushRemotePreferences(preferences: object) {
  pendingPush = { ...(preferences as Record<string, unknown>) };
  if (pushing) return;
  pushing = true;
  void (async () => {
    while (pendingPush !== null) {
      const next = pendingPush;
      pendingPush = null;
      try {
        await callRpc("setPreferences", { preferences: next });
      } catch {
        break;
      }
    }
    pushing = false;
  })();
}
