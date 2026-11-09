import { useEffect, useState } from "react";

export type MountState = "pending" | "mounted" | "missing";

export const MOUNT_GRACE_MS = 1500;

export interface MountSnapshot<Node> {
  token: string | null;
  host: Node | null;
  state: MountState;
}

const PENDING = { host: null, state: "pending" } as const;

export function watchMountHost<Slot, Node>({
  locate,
  attach,
  holds,
  detach,
  observe,
  onChange,
  graceMs = MOUNT_GRACE_MS,
}: {
  locate: () => Slot | null;
  attach: (slot: Slot) => Node;
  holds: (slot: Slot, node: Node) => boolean;
  detach: (node: Node) => void;
  observe: (listener: () => void) => () => void;
  onChange: (host: Node | null, state: MountState) => void;
  graceMs?: number;
}): () => void {
  let current: Node | null = null;
  let state: MountState | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const report = (host: Node | null, next: MountState) => {
    if (state === next && (next !== "mounted" || host === current)) return;
    state = next;
    onChange(host, next);
  };
  const stopGrace = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };
  const sync = () => {
    const slot = locate();
    if (current !== null && slot !== null && holds(slot, current)) return;
    if (current !== null) detach(current);
    current = null;
    if (slot === null) {
      if (state === "missing" || timer !== null) return;
      report(null, "pending");
      timer = setTimeout(() => {
        timer = null;
        if (current === null) report(null, "missing");
      }, graceMs);
      return;
    }
    stopGrace();
    current = attach(slot);
    report(current, "mounted");
  };

  sync();
  const stop = observe(sync);
  return () => {
    stop();
    stopGrace();
    if (current !== null) detach(current);
    current = null;
  };
}

export function visibleMount<Node>(snapshot: MountSnapshot<Node>, token: string | null): { host: Node | null; state: MountState } {
  if (token === null || snapshot.token !== token) return PENDING;
  return { host: snapshot.host, state: snapshot.state };
}

export function useMountedHost(
  active: boolean,
  key: string,
  locate: () => HTMLElement | null,
  mount: (slot: HTMLElement, node: HTMLElement) => void,
  className: string,
  attr: string,
): { host: HTMLElement | null; state: MountState } {
  const token = active ? key : null;
  const [snapshot, setSnapshot] = useState<MountSnapshot<HTMLElement>>({ token: null, host: null, state: "pending" });

  useEffect(() => {
    if (token === null) return;
    let marked: HTMLElement | null = null;
    const stop = watchMountHost<HTMLElement, HTMLElement>({
      locate,
      attach: (slot) => {
        const node = document.createElement("div");
        node.className = className;
        mount(slot, node);
        marked = slot.closest<HTMLElement>("header") ?? slot;
        marked.setAttribute(attr, "");
        return node;
      },
      holds: (slot, node) => node.parentElement === slot,
      detach: (node) => {
        node.remove();
        marked?.removeAttribute(attr);
        marked = null;
      },
      observe: (listener) => {
        const observer = new MutationObserver(listener);
        observer.observe(document.body, { childList: true, subtree: true });
        return () => observer.disconnect();
      },
      onChange: (host, state) => setSnapshot({ token, host, state }),
    });
    return () => {
      stop();
      setSnapshot({ token: null, host: null, state: "pending" });
    };
  }, [token]);

  return visibleMount(snapshot, token);
}
