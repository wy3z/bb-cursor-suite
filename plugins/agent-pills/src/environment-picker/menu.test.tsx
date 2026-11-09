import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CLOUD_LEARN_MORE_URL, buildModel, type Location, type PickerProvider, type PickerWorktree } from "./model";

const runtime = globalThis as unknown as { __bbPluginRuntime?: unknown };
runtime.__bbPluginRuntime ??= { react: React, pluginSdkApp: {} };
const host = runtime.__bbPluginRuntime as { pluginSdkApp: Record<string, unknown> };
host.pluginSdkApp.experimental_Icon ??= ({ name }: { name: string }) => React.createElement("span", { "data-icon": name });
host.pluginSdkApp.experimental_ProviderIcon ??= ({ provider }: { provider: { id: string } }) =>
  React.createElement("span", { "data-provider-icon": provider.id });

const { PickerMenu } = await import("./EnvironmentPicker");

const provider = (id: string, displayName: string, machineProviderId: string | null = null): PickerProvider => ({
  id,
  displayName,
  icon: null,
  logoUrl: null,
  machineProviderId,
  availability: null,
});

const LOCAL = provider("project-checkout", "Project checkout");
const WORKTREE = provider("git-worktree", "Worktree");
const MODAL = provider("modal-sandbox", "Modal Sandbox", "modal-sandbox");

function render(
  providers: PickerProvider[],
  location: Location | null = { kind: "local" },
  options: { catalog?: PickerProvider[]; worktrees?: PickerWorktree[]; viewportWidth?: number } = {},
): string {
  return renderToStaticMarkup(
    <PickerMenu
      model={buildModel(providers, options.worktrees ?? [], options.catalog ?? providers)}
      viewportWidth={options.viewportWidth ?? 1400}
      location={location}
      choose={() => undefined}
      close={() => undefined}
      position={{ top: 0, left: 0, maxHeight: 400 }}
    />,
  );
}

const items = (html: string) =>
  [...html.matchAll(/<(button|a)([^>]*role="menuitem(?:radio)?"[^>]*)>([\s\S]*?)<\/\1>/g)].map(([, tag, attrs = "", inner = ""]) => ({
    tag,
    text: inner.replace(/<[^>]+>/g, "").trim(),
    disabled: attrs.includes('aria-disabled="true"'),
    describedBy: attrs.match(/aria-describedby="([^"]*)"/)?.[1] ?? null,
    controls: attrs.match(/aria-controls="([^"]*)"/)?.[1] ?? null,
    checked: attrs.includes('aria-checked="true"'),
    href: attrs.match(/href="([^"]*)"/)?.[1] ?? null,
  }));

describe("PickerMenu", () => {
  it("lists Cloud first, then This Computer, then the worktree rows", () => {
    const rows = items(render([LOCAL, WORKTREE, MODAL]));
    expect(rows.map((row) => row.text)).toEqual(["Cloud", "This Computer", "New Worktree"]);
    expect(rows.find((row) => row.text === "This Computer")?.checked).toBe(true);
    expect(rows.find((row) => row.text === "Cloud")?.disabled).toBe(false);
  });

  it("shows Cloud disabled with a Learn more link when no cloud provider is installed", () => {
    const html = render([LOCAL, WORKTREE]);
    const rows = items(html);
    expect(rows[0]).toMatchObject({ text: "Cloud", disabled: true });
    const learnMore = rows.find((row) => row.text === "Learn more");
    expect(learnMore).toMatchObject({ tag: "a", href: CLOUD_LEARN_MORE_URL });
    expect(CLOUD_LEARN_MORE_URL).toMatch(/#cloud-agents$/);
  });

  it("marks the selected cloud provider", () => {
    const rows = items(render([LOCAL, MODAL], { kind: "cloud", providerId: "modal-sandbox" }));
    expect(rows.find((row) => row.text === "Cloud")?.checked).toBe(true);
    expect(rows.find((row) => row.text === "This Computer")?.checked).toBe(false);
  });

  it("ties the disabled Cloud explanation to the Cloud row and the Learn more link", () => {
    const html = render([LOCAL, WORKTREE]);
    const rows = items(html);
    const cloud = rows.find((row) => row.text === "Cloud")!;
    const learnMore = rows.find((row) => row.text === "Learn more")!;
    expect(cloud.describedBy).not.toBeNull();
    expect(learnMore.describedBy).toBe(cloud.describedBy);
    const note = html.match(new RegExp(`id="${cloud.describedBy!.replace(/[:]/g, "\\:")}"[^>]*>([^<]*)<`))?.[1];
    expect(note).toBe("Install a cloud machine plugin to run agents in the cloud.");
    expect(html).not.toContain("<p");
  });

  it("says Cloud isn't available for this project when the provider is installed but not offered here", () => {
    const html = render([LOCAL, WORKTREE], { kind: "local" }, { catalog: [LOCAL, WORKTREE, MODAL] });
    expect(html).toContain("Cloud isn&#x27;t available for this project.");
    expect(html).not.toContain("Install a cloud machine plugin");
  });

  it("points the Worktree... row at its submenu", () => {
    const worktrees = ["a", "b", "c", "d"].map((id, index) => ({ id, name: null, branchName: `feature-${id}`, path: null, updatedAt: index }));
    const rows = items(render([LOCAL, WORKTREE], { kind: "local" }, { worktrees, viewportWidth: 390 }));
    const more = rows.find((row) => row.text === "Worktree...");
    expect(more?.controls).toBeTruthy();
    expect(rows.some((row) => row.text.startsWith("feature-"))).toBe(false);
  });
});

