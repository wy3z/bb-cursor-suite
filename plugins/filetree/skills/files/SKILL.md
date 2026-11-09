---
name: files
description: Browse a thread's workspace or project sources, search paths, inspect Git status, read text, or prepare a file download with the FileTree plugin.
---

# Files

Use `bb files roots` first when you need a project source rather than the thread's workspace. Commands default to the current thread and its active workspace; pass `--thread ID` or `--root ID` to choose another scope.

```sh
bb files roots
bb files list src
bb files search "preview worker"
bb files git
bb files read README.md
bb files download slides.pptx
```

Quote paths and queries containing spaces. Paths are root-relative; absolute paths and traversal are rejected. Every command prints JSON and exits 0; a failure exits 1 with one line on stderr.

- `roots` returns `{ kind: "ready", activeRootId, roots }` or `{ kind: "unavailable", reason }`. Each root has a `rootId`, `label` and `rootPath`.
- `list` returns up to 1000 `entries` (`kind`, `name`, `path`); `search` returns up to 200 `matches`. Both set `truncated` when there were more.
- `git` returns `kind: "ready"` with `branch`, `headSha` and `changes` (`path`, `indexStatus`, `worktreeStatus`, `conflicted`), or `kind: "not-repository"` / `"unavailable"` with a `reason`.
- `read` returns `{ path, content, sha256 }` for UTF-8 text up to 128 KiB. Larger or binary files are refused; use `download`.
- `download` prepares a verified snapshot up to 25 MiB and returns a server-relative `contentUrl` valid for five minutes. Fetch it through the connected BB server's authenticated origin. Do not post or log download URLs anywhere else.

These commands never modify workspace files, and each call reads fresh data. For people, Files is a tab added from the right panel's **+** menu; picking a file opens it in BB's own viewer.

If a root id stops working, list roots again. If Files says it can't browse a machine, that host's operating system or architecture has no native addon (it ships darwin-arm64, darwin-x64, linux-arm64, linux-x64 and win32-x64); do not replace descriptor confinement with pathname checks.
