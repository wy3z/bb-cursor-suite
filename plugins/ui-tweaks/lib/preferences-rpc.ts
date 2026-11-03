import { defineRpcContract, type StandardSchemaV1 } from "@get-bb/plugin-sdk";

export const PREFERENCES_KV_KEY = "preferences";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schema<T>(
  accept: (value: unknown) => value is T,
  message: string,
): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "bb-plugin-ui-tweaks",
      validate: (value) =>
        accept(value) ? { value } : { issues: [{ message }] },
    },
  };
}

const anyInput = schema(
  (value): value is unknown => value === null || value === undefined || isJsonObject(value),
  "Expected no input",
);

const remotePreferences = schema(
  (value): value is { preferences: JsonObject | null } =>
    isJsonObject(value) &&
    (value.preferences === null || isJsonObject(value.preferences)),
  "Expected { preferences: object | null }",
);

const preferencesInput = schema(
  (value): value is { preferences: JsonObject } =>
    isJsonObject(value) && isJsonObject(value.preferences),
  "Expected { preferences: object }",
);

const okOutput = schema(
  (value): value is { ok: true } => isJsonObject(value) && value.ok === true,
  "Expected { ok: true }",
);

export const preferencesRpcContract = defineRpcContract({
  getPreferences: { input: anyInput, output: remotePreferences },
  setPreferences: { input: preferencesInput, output: okOutput },
});
