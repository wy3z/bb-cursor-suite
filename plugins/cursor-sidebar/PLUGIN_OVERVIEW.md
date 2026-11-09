Cursor Sidebar replaces BB's thread list with a port of Cursor's sidebar.
Chats nest under their parent, pinned chats gather in one block, and you group them by project, update, status, environment or not at all.
Agents can set a project's icon from a shell; everything else is for people.

## For agents

### CLI: `bb cursor-sidebar icon`

```
bb cursor-sidebar icon <set <file.png> | glyph <Name|--list> | clear | get> [--project <id|name>]
```

| Subcommand | Does | Output (stdout, plain text) |
|---|---|---|
| `get` | Shows the project's icon | `<project name>: folder (default)`, `glyph <Name> (<colour>)`, `uploaded image`, `emoji <e>`, `monogram <text> (<colour>)` or `unrecognised value "<raw>"` |
| `glyph <Name>` | Sets a built-in glyph, matched case-insensitively | `<project name>: icon set to <Name>.` |
| `glyph --list` | Lists the glyph names, one per line. Needs no project | the names |
| `set <file.png>` | Stores a PNG as the icon. The path is read on the BB server's machine, relative to the caller's working directory | `<project name>: icon set from <absolute path>.` |
| `clear` | Goes back to the folder | `<project name>: icon reset to the folder.` |

- `--project` (or `-p`) takes a project id or a case-insensitive name. Without it the calling thread's project is used. Two projects with the same name are refused; pass the id.
- The PNG must start with the PNG signature, be under 192 KB and at most 1024 px on each side. 64 to 256 px, square, with a transparent background is plenty.
- Errors exit 1 with one line on stderr, for example `No project matches "web".`.
- There is no `--json` option.

```sh
bb cursor-sidebar icon glyph Rocket
bb cursor-sidebar icon set ./icon.png --project "Website Redesign"
bb cursor-sidebar icon get
```

### Agent tools and MCP

None of its own. Through BB's MCP server, the `run` tool can run the CLI above.

### RPC (plugin id `cursor-sidebar`)

The app's own surface; other plugins may call it with `sdk.plugins.callRpc`. Inputs are validated with zod.

| Method | Input | Output |
|---|---|---|
| `listProjectIcons` | `{}` | `{ icons: { projectId, icon }[] }` |
| `setProjectIcon` | `{ projectId, icon: string \| null }`. `icon` is a stored value (up to 200 chars) or a `data:image/png;base64,` URL up to 256 KB | `{ icons }` |
| `iconGlyphs` | `{ names: string[] \| null }` | `{ glyphs: Record<name, element[]> }`, the glyph artwork |
| `sidebarView` | `{}` | `{ view: SidebarView \| null }` |
| `setSidebarView` | `{ view: SidebarView }` | `{ view }` |
| `listThreadOrders` | `{}` | `{ orders: { scope, threadIds, revision }[] }` |
| `reorderThreads` | `{ scope, threadIds, expectedRevision }` | `{ threadIds, revision, applied }`. A stale `expectedRevision` returns `applied: false` and the current order |
| `listThreadSections` | `{}` | `{ sections: { id, name }[] }` |
| `renameThreadSection` | `{ id, name }` | `{ section: { id, name } }` |
| `deleteThreadSection` | `{ id }` | `{ updatedThreadCount }` |
| `setThreadSection` | `{ threadIds (1-500), sectionId \| null }` | `{ updated: string[], failed: string[] }` |
| `setThreadParent` | `{ threadId, parentThreadId \| null }` | `{ threadId, parentThreadId }` |
| `deleteNativeProject` | `{ projectId }` | `{ ok: true }`. Deletes the BB project and its icon |
| `listWorkspaces` | `{ environmentIds (max 100) }` | `{ workspaces: { environmentId, path, name, hostId }[] }` |
| `listWorkspaceTabs` | `{ threadIds (max 100) }` | `{ available, threads: { threadId, workspaceId, workspaceName }[] }`. `available` is false without the Workspaces plugin |
| `transcript` | `{ threadId }` (`thr_...`) | `{ text }`, from `bb thread log <id> --all --format minimal` |
| `primaryHost` | `{}` | `{ hostId \| null }` |
| `cloudHosts` | `{}` | `{ hostIds: string[] }` |

`SidebarView` is `{ groupBy: "workspace" | "updated" | "status" | "environment" | "none", sortConversationsBy: "updated" | "status", sortGroupsBy: "manual" | "updated", sortProjectsBy: "manual" | "status", threadsPerGroup: 5 | 10 | 20 | 50 | null, statusFilter, ageFilter, environmentFilter, projectFilter, prFilter, show: { updated, environment, branch, host, pr, providerIcons, projectIcons } }`. `groupBy: "workspace"` is the Projects grouping.

```ts
await sdk.plugins.callRpc({
  pluginId: "cursor-sidebar",
  method: "listProjectIcons",
  input: {},
  outputSchema: z.object({ icons: z.array(z.object({ projectId: z.string(), icon: z.string() })) }),
});
```

### Realtime channels

`thread-order` (`{ scope }`), `project-icon` (`{ projectId }`), `sidebar-view`, `thread-sections` (`{ id }`) and `cloud-hosts`.

### What it reads from other plugins

- Tasks (`tasks`): `listProjects`, `listAllTasks`, `createProject`.
- Projects (`projects`): `listLeads`, `getMeta`, `listIcons`, `setIcon`, `setLead`, for board rows and their icons. Without Projects there are no board rows.
- Pull Requests (`pull-requests`): `changeRequests` for the pull and merge request marks. Without it the sidebar asks GitHub PR Status (`bb--github-pr-status`) alone.
- BB's git plugin (`bb--git`): `status`, for the row's git facts.
- Workspaces (`workspaces`), when it runs: thread metadata, so a workspace's chats nest under its first chat.

### Storage

SQLite in the plugin's data directory: `sidebar_view`, `project_icon`, `thread_order`, `thread_order_revision`, `thread_lifecycle` and `project_visibility`. Native projects, pins and folders stay in BB.

## Reference

### Grouping

- **Projects** nests each chat under its project.
- **Updated** groups chats by last activity: Today, Yesterday, Last 7 days, Last 30 days, Older.
- **Status** groups by the strongest status in the group, in this order: Needs your input, Failed, Unread, Working, Idle.
- **Environment** groups by the machine the chat ran on, including chats with none.
- **None** draws one flat list. Pinned chats still come first under **Pinned**, child chats still nest, and the rows follow the chat order.

Every grouping uses the same sections: Pinned first, then the grouping's own headings, then **Chats** for standalone chats. An empty heading is never drawn. Under Projects, a project with no visible chat is hidden, except the one picked in the switcher, which says **No threads**.

### Toolbar and headings

One fixed row sits above the list: the project switcher on the left and the view menu on the right. A section heading is a small muted label that folds its block. When a working chat inside a folded or filtered project is out of sight, a small spinner sits on the project folder's corner. Chats under a Projects board count towards the board row, not their repository.

### Rows

A row can show its project icon, a status glyph and a metadata line. When a chat has working child chats, its age becomes a small accent pill with their count. Every row shares one left edge, with icons in one 14 px column. Child chats sit under their parent with no indent and a small corner arrow before the age; the pull request and provider marks sit there too. The header, the thread list and the footer sit 4 px further in from the sidebar's left edge than BB's own (`--cs-left-extra` in `app.css`).

### The view menu

| Control | What it changes |
| --- | --- |
| **Grouping** | Projects, Updated, Status, Environment or None |
| **Chat order** | Updated or Status |
| **Project order** | Manual, or by worst status then most recent use. Projects grouping only |
| **Group order** | Updated or Default. Every grouping except Projects and None |
| **Threads per group** | 5, 10, 20, 50 or All. 10 by default |
| **Show** | Updated time, environment, branch, machine, the pull or merge request mark, provider icons and project icons |
| **Status filter** | Needs your input, Failed, Unread, Working, Idle |
| **Age filter** | Today, Yesterday, Last 7 days, Last 30 days, Older |
| **Environment filter** | Which environments appear, including chats with none |
| **PR / MR filter** | Draft, Open, Merged, Closed, No PR / MR. A row whose request is loading or can't be checked stays visible |
| **Expand All / Collapse All** | Every section and group |
| **Mark All as Read** | Every loaded chat that is unread |

**Threads per group** bounds every section and the child chats under a parent. **Show N more** reveals the next page. A chat that is working, needs input, is selected or pinned always shows.

A warning mark on the menu button means a view change has not reached the server. The notice inside the menu has a Retry button.

### Project switcher

It reads **All projects**, one project's name, or **N projects**. Click it for every project and **New project…**, which opens BB's Add project dialog. Picking one project narrows every grouping, and under Projects grouping it drops that project's heading. While one project is picked, the menu also offers **Set icon…**.

### Project icons

Open the picker from a project heading's right-click or Actions menu (**Set icon…**), the switcher, or a chat row's right-click menu (**Set project icon…**). It is a port of Cursor's picker, shared with Projects (`@wy3z/bb-suite/project-icon/picker`): search, Cursor's ten colours, Cursor's icon grid with **No icon** first, and an image button to upload or paste a PNG, shrunk to 64 px. Emoji and monogram icons saved by an earlier picker still show, but the picker no longer makes them. Board rows wear the board's own icon from Projects.

The icons also replace BB's folder in the composer: the project label under the prompt box, the project button on the New thread screen and its picker. BB has no project icon field, so these are matched by project name.

### Workers under a project lead

Clicking a worker under a project lead opens it as a tab of the lead, the same way the Projects board does, so the lead's side panel stays. Ctrl or Cmd-click still opens a split. Clicking the lead's own row brings back the lead's tab, and while a worker tab shows, only the worker's row is highlighted (not the lead's or its board row). Without a Projects build that shows lead tabs, worker rows open on their own route. Other top-level chats, and children with no lead above them, open as usual. This uses `@wy3z/bb-suite/thread-tabs`, shared with Projects.

### Mobile

| | Do this |
| --- | --- |
| Open a chat | Tap the row |
| Fold a project | Tap its name |
| Pin a chat | Swipe the row left |
| Archive a chat | Swipe the row right |
| Move a chat or a project | Hold until the row lifts, then drag |
| Open the actions menu | Hold until the row lifts, then let go without moving |
| Reorder a project without dragging | Hold the heading, then pick Move up or Move down. Manual project order only |

A swipe has to travel 72 px to commit. Dropping a lifted chat on the middle of another chat in the same project nests it, and shows a **Make child** label first.

### Workspaces

With the Workspaces plugin running, a workspace's chats nest under its first chat, and that row shows the workspace's name. Top-level chats that share a worktree count as one workspace.

### Navigation

The plugin adds two sidebar navigation layouts, **Compact** (`cursor-sidebar/compact`) and **Cursor** (`cursor-sidebar/cursor`). BB switches to the first one a plugin adds unless you have picked one, so after install the sidebar uses Compact, and a note above the list says so until dismissed. Compact puts Search in the header and other destinations behind a **Plugins** button in the footer. Cursor lists the destinations as rows.

### Requirements

BB 0.49 or newer, with plugin SDK 0.6.132 or newer. No account or external service.

---

Not affiliated with, endorsed by or sponsored by Anysphere, Inc. Cursor is a trademark of Anysphere, Inc.
