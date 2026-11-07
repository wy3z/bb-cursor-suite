import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const TASKS_PLUGIN = "tasks";
export const PROJECTS_PLUGIN = "projects";

export const tasksContract = defineRpcContract({
  createProject: {
    input: z
      .object({
        name: z.string().trim().min(1),
        prefix: z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/),
        color: z.string().trim().min(1),
        folderId: z.string().nullable().default(null),
        linkedBbProjectId: z.string().startsWith("proj_").nullable().default(null),
      })
      .strict(),
    output: z.object({ project: z.object({ id: z.string(), prefix: z.string() }).passthrough() }).passthrough(),
  },
  listProjects: {
    tags: () => ["projects"],
    input: z.object({}).strict(),
    output: z
      .object({
        projects: z.array(
          z.object({ id: z.string(), name: z.string(), prefix: z.string(), linkedBbProjectId: z.string().nullable() }).passthrough(),
        ),
      })
      .passthrough(),
  },
  listAllTasks: {
    tags: (input: { projectId: string }) => [`tasks:${input.projectId}`],
    input: z.object({ projectId: z.string() }).strict(),
    output: z.object({ tasks: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()) }).passthrough(),
  },
});

const metaSchema = z.object({
  focus: z.string().nullable(),
  focusUpdatedAt: z.string().nullable(),
  leadThreadId: z.string().nullable(),
});

export const projectsContract = defineRpcContract({
  getMeta: {
    tags: (input: { projectId: string }) => [`meta:${input.projectId}`],
    input: z.object({ projectId: z.string().trim().min(1).max(100) }),
    output: metaSchema.passthrough(),
  },
  listLeads: {
    tags: () => ["leads"],
    input: z.object({}),
    output: z.object({ leads: z.array(z.object({ projectId: z.string(), threadId: z.string(), focus: z.string().nullable() })) }),
  },
  setLead: {
    input: z.object({ projectId: z.string().trim().min(1).max(100), threadId: z.string().startsWith("thr_").nullable() }),
    output: metaSchema,
  },
});
