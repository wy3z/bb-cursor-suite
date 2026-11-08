# Development and CLI

To develop or rebuild it, use Node.js 22 or newer, npm, and the stable BB CLI on PATH:

```sh
git clone https://github.com/wy3z/bb-plugin-filetree.git
cd bb-plugin-filetree
npm ci            # at the repository root
npm run verify
bb plugin install .
```

The repository contains **FileTree** (`bb-plugin-filetree`, plugin ID `filetree`).

The plugin pins public SDK 0.6.132 and requires BB 0.49 or newer. It does not change BB's core APIs, daemon protocol, or application dependencies. The descriptor-based native addon is embedded in the host artifact for darwin-arm64, darwin-x64, linux-arm64, linux-x64 and win32-x64, so the enrolled host does not need a compiler. On any other host, or when the addon can't load (for example on musl), the Files tab shows why instead of a file tree. Confinement fails closed.

To prepare an installable package after the build:

```sh
npm pack
bb plugin install ./bb-plugin-filetree-0.3.0.tgz
```

The repository includes the generated worker and native-asset modules needed by BB's Git installer, which skips generation scripts. `npm run build` regenerates them from source. Commit updated generated assets with source changes before publishing.

## Native addon

`host/native/host_native_files.c` is the POSIX addon (Linux and macOS). `host/native/host_native_files_win.c` is the Windows port. It opens each path component relative to its parent handle with `NtCreateFile` and refuses symbolic links, junctions and alternate data streams. Every reopen is checked against the original file ID. Git runs only when the root can be pinned and its path still resolves to the pinned directory, inside a job object, using Git for Windows from Program Files or `%LOCALAPPDATA%\Programs\Git`. Windows roots must be local drive paths.

Git runs with the repository's own config switched off wherever it could run code. Every invocation passes `--no-optional-locks` and `--no-pager`, empties `core.fsmonitor` and `diff.external`, and points `core.hooksPath` at a path that can't exist: `/dev/null` on Linux and macOS, and a name under the `git.exe` file on Windows, because a bare `/dev/null` there resolves against the repository's drive. Before `git status`, Files lists the `filter`, `diff`, `merge` and `hook` entries the config defines. It blanks each driver's commands with `-c` and sets `hook.<name>.enabled=false` for each config-defined hook (Git 2.54 and later). Git status is turned off for the repository when the listing isn't valid UTF-8, or when a name can't be expressed with `-c` because it contains `=`. The environment sets `GIT_OPTIONAL_LOCKS=0`, so status never writes the index or takes `index.lock`. It sets `GIT_ALLOW_PROTOCOL=none` and `GIT_NO_LAZY_FETCH=1`, so a partial clone can't fetch missing objects through a transport the repository chose. It points `HOME` and `XDG_CONFIG_HOME` at that same unreachable path and sets `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and `GIT_CONFIG_NOSYSTEM`. Global and system config, global attributes and the global ignore file are therefore skipped on every Git version, including 2.30 and 2.31, which predate `GIT_CONFIG_GLOBAL`. The native addon pins these variables itself, whatever the caller passes. The hostile-repository test passes with Git 2.30.9 and 2.56.0.

`generated/native-assets.ts` embeds one build per platform, each tagged with a digest of the C sources git tracks under `host/native`. `npm run generate` only compiles the addon for your machine when its embedded build doesn't match the current source, which needs a C compiler, Python and Node headers. A local build is for testing only: it has no provenance, so CI rejects it. A test fails until every platform carries a build of the current source.

The "Files native addon" workflow (`.github/workflows/files-native.yml`) builds and tests the addon on native runners for every platform, and attests each build with GitHub's build provenance. Linux builds run in a digest-pinned Debian bullseye container, so the addon needs glibc 2.29 or newer rather than the runner's, and they are reproducible. The collect job assembles a new `native-assets.ts` and uploads it as `files-native-assets`. It then fails unless every committed build has a provenance attestation from this workflow whose source commit (`sourceRepositoryDigest`) has the same build inputs as HEAD: `.github/workflows/files-native.yml`, `plugins/filetree/scripts/native-assets.mjs`, `plugins/filetree/host/native` and `package-lock.json`. It also fails unless each committed Linux build is byte-identical to this run's build of the same source. The source commit's trees come from the local clone when it has that commit. Otherwise one aliased GraphQL query fetches them. A change to any build input therefore needs a fresh native run and an import, just like a C change.

After changing the C source, push, let the workflow build, then import its result and push again:

```sh
gh run download <run-id> --repo wy3z/bb-cursor-suite --name files-native-assets --dir plugins/filetree/generated
```

The first run after a C change fails its final verification step, because the committed builds are still the old ones. The run after the import passes. `node scripts/native-assets.mjs --check` reports any platform that is missing or stale, and `--verify` runs the provenance check locally (it needs `gh`). `.github/CODEOWNERS` covers the workflow, the native sources, this script and `native-assets.ts`.

## CLI

Commands return JSON. `--thread` defaults to the invoking BB thread; `--root` defaults to that thread's active workspace. Root identifiers come from `roots` and become invalid when the source moves or changes hosts.

```sh
bb files roots --thread THREAD_ID
bb files list src --thread THREAD_ID
bb files search "preview worker" --thread THREAD_ID
bb files git --thread THREAD_ID
bb files read README.md --thread THREAD_ID
bb files download slides.pptx --thread THREAD_ID --root ROOT_ID
```

`read` accepts UTF-8 text up to 128 KiB. `download` returns a relative `contentUrl` for the BB server, valid for five minutes; fetch it through the same authenticated BB origin. Files over 25 MiB are rejected. File operations are read-only.

## SDK and RPC

`contracts/rpc.ts` exports the typed plugin contract used by the frontend's `useRpc`. Other SDK consumers can call `sdk.plugins.callRpc` with plugin ID `filetree` and methods `roots`, `directory`, `search`, `gitStatus`, `transfer`, `cancel`, or `watch`, supplying the corresponding contract schema. `transfer`, `search` and `gitStatus` require an `operationId`; pass the same thread/root/operation identity to `cancel` to abort an in-flight request. `watch` returns the current `rootIds` and whether all native watches were established. The CLI exercises the same service. No `sdk.files.explorer` extension is required.

The server resolves the thread, environment, and project sources through `bb.sdk` before host I/O and checks the root identity again before publishing results. Clients cannot supply a host or absolute root path. Directory listing, search and Git retain descriptor-relative host operations. File reads use the stable `sdk.files.read` API and its path/symlink handling; they no longer use the plugin’s descriptor-relative read implementation. The server checks the returned size and SHA-256, then retains immutable download bytes in a cache bounded to 100 MiB including reservations for in-flight reads. BB limits images to 10 MiB and other files to 25 MiB. Missing modification times are returned as `null`.

The panel renews native watches every 30 seconds. Watches expire 75 seconds after their last renewal; worker disposal closes them. Signals invalidate only their affected root. Reconnects and changes to the watched root inventory reconcile the panel; failed watch setup falls back to periodic refresh. Successful lease renewals do not reload every preview.

## Verification

```sh
npm run verify
```

Tests cover confinement races, Git helper isolation (including a hostile repository whose fsmonitor, filters, hooks and partial-clone remote would run code under a plain `git status`), stale-root rejection, bounded SDK reads and immutable downloads, previews, cancellation, persistent tree state, and omission of the removed actions. The smoke task loads the built host artifact from a fresh directory, exercises its embedded native addon, rejects a symlink escape, and exercises directory listing and search. Server tests cover immutable 25 MiB downloads, integrity failures, cancellation and capacity recovery.

Controls and the responsive drawer in `vendor/` come from BB’s 0.42.1 registry/shared UI. The split view uses `react-resizable-panels`, with saved widths and a collapsible file tree. The plugin remains independently buildable. It preserves deferred content realization and avoids hiding or making the app root inert.
