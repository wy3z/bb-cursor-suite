import "@wy3z/bb-suite/tokens.css";
import "@wy3z/bb-suite/project-icon.css";
import "@wy3z/bb-suite/settings.css";
import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { CursorSidebar } from "./src/CursorSidebar";
import {
  CompactNavigation,
  CompactNavigationFooter,
  CompactNavigationHeader,
} from "./src/CompactNavigation";
import { CursorNavigation } from "./src/CursorNavigation";
import { SidebarSettings } from "./src/SidebarSettings";

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "cursor-sidebar",
    title: "Cursor Sidebar",
    description:
      "A Cursor-style sidebar: project trees, standalone chats, pins, folders and aggregate activity.",
    component: CursorSidebar,
  });

  app.slots.experimental_sidebarNavigation({
    id: "cursor",
    title: "Cursor",
    description:
      "Compact header, then BB's navigation destinations as rows like Cursor's New Chat, Automations and Customize.",
    placement: "list",
    component: CursorNavigation,
    headerComponent: CompactNavigationHeader,
  });

  app.slots.experimental_sidebarNavigation({
    id: "compact",
    title: "Compact",
    description:
      "Search and New thread in the header, back/forward on the right, other destinations behind a Plugins footer button; no navigation rows.",
    placement: "list",
    component: CompactNavigation,
    headerComponent: CompactNavigationHeader,
  });

  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "navigation",
    label: "Plugins",
    icon: "Plug02",
    component: CompactNavigationFooter,
  });

  app.slots.settingsSection({
    id: "sidebar",
    title: "Sidebar",
    component: SidebarSettings,
  });
});
