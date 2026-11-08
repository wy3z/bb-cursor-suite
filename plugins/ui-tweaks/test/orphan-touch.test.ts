import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardOrphanedTouchEnds } from "../lib/orphan-touch.ts";

class FakeTarget {
  isConnected = true;
  listeners = new Map<string, Set<(event: Event) => void>>();
  addEventListener(type: string, listener: (event: Event) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type, target: this } as unknown as Event);
  }
}

function setup() {
  const doc = new FakeTarget();
  const controller = new AbortController();
  const cancelled: string[] = [];
  forwardOrphanedTouchEnds(doc as never, controller.signal, (ending) => cancelled.push(ending.type));
  const start = (target: FakeTarget) => {
    for (const listener of doc.listeners.get("touchstart") ?? []) listener({ type: "touchstart", target } as unknown as Event);
  };
  return { controller, cancelled, start };
}

test("a touch whose element left the page ends with a window touchcancel", () => {
  const { cancelled, start } = setup();
  const target = new FakeTarget();
  start(target);
  target.isConnected = false;
  target.fire("touchend");
  assert.deepEqual(cancelled, ["touchend"]);
  assert.equal(target.listeners.get("touchend")?.size, 0);
});

test("a touch on an element still in the page is left alone", () => {
  const { cancelled, start } = setup();
  const target = new FakeTarget();
  start(target);
  target.fire("touchend");
  target.isConnected = false;
  target.fire("touchend");
  assert.deepEqual(cancelled, []);
});

test("nothing is forwarded after the content script unmounts", () => {
  const { controller, cancelled, start } = setup();
  const target = new FakeTarget();
  start(target);
  controller.abort();
  target.isConnected = false;
  target.fire("touchcancel");
  assert.deepEqual(cancelled, []);
});
