import {
  defineRpcContract,
  type ExperimentalHostSignals,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  nativeFileDirectoryResultSchema,
  nativeFileSearchResultSchema,
  nativeFileGitStatusResultSchema,
  nativeFileRelativePathSchema,
} from "./model.js";
import { isAbsoluteHostPath } from "./host-path.js";
const rootPath = z
  .string()
  .min(1)
  .max(8192)
  .refine(isAbsoluteHostPath, { message: "Root path must be absolute" });
const root = z.object({ rootPath }).strict();
export const hostContract = defineRpcContract({
  directory: {
    input: root.extend({ path: nativeFileRelativePathSchema }).strict(),
    output: nativeFileDirectoryResultSchema,
  },
  search: {
    input: root
      .extend({
        query: z.string().trim().min(1).max(200),
        limit: z.number().int().min(1).max(200),
      })
      .strict(),
    output: nativeFileSearchResultSchema,
  },
  gitStatus: { input: root, output: nativeFileGitStatusResultSchema },
  support: {
    input: z.object({}).strict(),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("supported") }).strict(),
      z
        .object({
          kind: z.literal("unsupported"),
          platform: z.string().max(100),
          reason: z.string().max(1000),
        })
        .strict(),
    ]),
  },
  watch: {
    input: root
      .extend({
        threadId: z.string().min(1).max(200),
        rootId: z.string().min(1).max(500),
      })
      .strict(),
    output: z.object({ watching: z.boolean() }).strict(),
  },
});
export const hostSignals = {
  changed: {
    payload: z.object({ threadId: z.string(), rootId: z.string() }).strict(),
  },
} satisfies ExperimentalHostSignals;
