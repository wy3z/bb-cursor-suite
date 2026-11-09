Files adds a read-only file tree to BB's right panel, opened from the panel's + menu.
It browses a thread's workspace and its project's sources, with path search, Git status and live updates, and opens files in BB's own viewer.
Agents get the same reads through `bb files`.

## For agents

### CLI: `bb files`

```
bb files <roots|list|search|git|read|download> [path-or-query] [--thread ID] [--root ID]
```

- `--thread` defaults to the thread running the command. Outside a thread it is required.
- `--root` defaults to the thread's active workspace. Root ids come from `roots`; they go stale when the source moves or changes hosts, so list roots again.
- Paths are root-relative. Absolute paths and `..` are rejected. Quote paths and queries with spaces; more than one positional is an error.
- Every command prints pretty JSON on stdout and exits 0. Errors exit 1 with one line on stderr. Output over 1 MB is refused; narrow the query.
- Nothing here changes workspace files.

| Command | Does | Output |
|---|---|---|
| `roots` | Lists the roots this thread may browse | `{ kind: "ready", threadId, activeRootId, roots: Root[] }` or `{ kind: "unavailable", threadId, reason }` |
| `list [path]` | Lists one directory (the root when omitted), up to 1000 entries | `{ rootId, path, entries: { kind: "file" \| "directory", name, path }[], truncated }` |
| `search <query>` | Matches relative paths, up to 200 results | `{ rootId, matches: { kind, name, path }[], truncated }` |
| `git` | Reads Git status, up to 5000 changes | `{ rootId, kind: "ready", branch, headSha, changes: { path, previousPath, indexStatus, worktreeStatus, conflicted, generated }[], truncated }`, or `{ rootId, kind: "not-repository" \| "unavailable", reason }` |
| `read <path>` | Reads UTF-8 text up to 128 KiB. Binary files and larger files are refused; use `download` | `{ path, content, sha256 }` |
| `download <path>` | Prepares a verified snapshot up to 25 MiB, valid for five minutes | `{ rootId, path, filename, mimeType, sizeBytes, sha256, modifiedAtMs, contentUrl, expiresAtMs }` |

`Root` is `{ rootId, label, projectId, hostId, rootPath, isActiveEnvironment, gitCapability: "known-git" | "known-non-git" | "unknown", reference, navigationRoot }`. `reference` is `{ kind: "environment", environmentId }` or `{ kind: "project-source", projectId, sourceId }`.

Status codes in `indexStatus` and `worktreeStatus` are one of `.`, `M`, `T`, `A`, `D`, `R`, `C`, `U` and `?`.

`contentUrl` is relative to the BB server (`/api/v1/plugins/filetree/http/download?id=...`). Fetch it through the same authenticated BB origin. Don't post or log it anywhere else. An expired id returns 410.

```sh
bb files roots
bb files list src
bb files search "preview worker"
bb files git
bb files read README.md
bb files download slides.pptx --root ROOT_ID
```

### Agent tools and MCP

None of its own. Through BB's MCP server, the `run` tool can run `bb files`.

### Skill

`skills/files/SKILL.md` (`files`) teaches the CLI above.

### RPC (plugin id `filetree`)

The CLI and the app call the same service. Contract: `contracts/rpc.ts`, schemas in `contracts/api.ts`. All inputs are strict objects.

| Method | Input | Output |
|---|---|---|
| `roots` | `{ threadId }` | as `bb files roots` |
| `directory` | `{ threadId, rootId, path }` | as `bb files list` |
| `search` | `{ threadId, rootId, query, limit (1-200), operationId }` | as `bb files search` |
| `gitStatus` | `{ threadId, rootId, operationId }` | as `bb files git` |
| `transfer` | `{ threadId, rootId, path, operationId }` | as `bb files download` |
| `cancel` | `{ threadId, rootId, operationId }` | `{ cancelled }`. Aborts an in-flight `search`, `gitStatus` or `transfer` |
| `watch` | `{ threadId }` | `{ watching, rootIds }`. Starts or renews native watches |

```ts
await sdk.plugins.callRpc({
  pluginId: "filetree",
  method: "roots",
  input: { threadId: "thr_..." },
  outputSchema: rpcContract.roots.output,
});
```

### HTTP route

`GET /download?id=<id>` under the plugin's HTTP prefix serves a prepared download as an attachment, with `Cache-Control: no-store` and a sandboxing CSP.

### Realtime channel

`files-changed`, payload `{ threadId, rootId }`, published when a native watch on that root reports a change. Only that root is refreshed.

### Settings

None. The settings page says so and points to the Files tab.

## Reference

- The server resolves the thread, environment and project sources through BB before any host I/O, and checks the root again before returning results. Clients can't supply a host or an absolute root path.
- Directory listing, search and Git status run on the environment's machine through a native addon that opens every path component relative to its parent handle and refuses symlink escapes. File reads use BB's `sdk.files.read`, and the server checks the size and SHA-256 of what it got.
- Downloads are kept in a cache bounded to 100 MiB, including reservations for reads still in flight.
- Git runs with the repository's own config switched off wherever it could run code. See the [suite-shared Git safety section](../../packages/suite-shared/README.md#git-safety).
- The panel renews native watches every 30 seconds; a watch expires 75 seconds after its last renewal. If watches can't be set up, the panel falls back to periodic refresh.
- Native addons ship for darwin-arm64, darwin-x64, linux-arm64, linux-x64 (glibc 2.29 or newer) and win32-x64. On any other host, or when the addon can't load, the Files tab explains why instead of showing a tree.

Building, the native addon and its provenance checks are in [docs/development.md](docs/development.md).

---

Not affiliated with, endorsed by or sponsored by Anysphere, Inc. Cursor is a trademark of Anysphere, Inc.
