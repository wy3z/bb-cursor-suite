import { describe, expect, it } from "vitest";
import {
  EMPTY_RESPONSE,
  type ActivityResponse,
  readActivity,
  refreshActivity,
  subscribeActivity,
} from "./activity-store";

interface Deferred {
  resolve: (response: ActivityResponse) => void;
  reject: (error: unknown) => void;
}

function fakeFetch() {
  const calls: Deferred[] = [];
  const fetch = () =>
    new Promise<ActivityResponse>((resolve, reject) => {
      calls.push({ resolve, reject });
    });
  return { calls, fetch };
}

function result(threadId: string): ActivityResponse {
  return {
    ...EMPTY_RESPONSE,
    models: [{ threadId, model: null }],
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function keyFor(name: string): string {
  return `thr_${name}::`;
}

describe("activity store", () => {
  it("fetches once for three subscribers and notifies all of them", async () => {
    const key = keyFor("shared");
    const { calls, fetch } = fakeFetch();
    const notified: number[] = [];
    const listeners = [0, 1, 2].map((index) => () => {
      notified.push(index);
    });

    const unsubscribe = listeners.map((listener) =>
      subscribeActivity(key, fetch, listener),
    );

    expect(calls).toHaveLength(1);

    const payload = result("thr_child");
    calls[0].resolve(payload);
    await flush();

    expect(notified).toEqual([0, 1, 2]);
    expect(readActivity(key)).toBe(payload);

    unsubscribe.forEach((stop) => stop());
  });

  it("collapses three refreshes in one tick into one more fetch", async () => {
    const key = keyFor("refresh");
    const { calls, fetch } = fakeFetch();
    const unsubscribe = subscribeActivity(key, fetch, () => undefined);

    calls[0].resolve(result("thr_first"));
    await flush();
    expect(calls).toHaveLength(1);

    refreshActivity(key);
    refreshActivity(key);
    refreshActivity(key);
    expect(calls).toHaveLength(1);

    await flush();
    expect(calls).toHaveLength(2);

    unsubscribe();
  });

  it("starts exactly one follow-up when refreshed mid-flight", async () => {
    const key = keyFor("inflight");
    const { calls, fetch } = fakeFetch();
    let notifications = 0;
    const unsubscribe = subscribeActivity(key, fetch, () => {
      notifications += 1;
    });

    refreshActivity(key);
    await flush();
    refreshActivity(key);
    await flush();
    expect(calls).toHaveLength(1);

    const first = result("thr_first");
    calls[0].resolve(first);
    await flush();
    expect(calls).toHaveLength(2);
    expect(readActivity(key)).toBe(first);

    const second = result("thr_second");
    calls[1].resolve(second);
    await flush();
    expect(calls).toHaveLength(2);
    expect(readActivity(key)).toBe(second);
    expect(notifications).toBe(2);

    unsubscribe();
  });

  it("starts from null and fetches again after the last subscriber leaves", async () => {
    const key = keyFor("restart");
    const { calls, fetch } = fakeFetch();
    const stop = subscribeActivity(key, fetch, () => undefined);

    const payload = result("thr_first");
    calls[0].resolve(payload);
    await flush();
    expect(readActivity(key)).toBe(payload);

    stop();
    expect(readActivity(key)).toBeNull();

    const stopAgain = subscribeActivity(key, fetch, () => undefined);
    expect(calls).toHaveLength(2);
    expect(readActivity(key)).toBeNull();

    calls[1].resolve(result("thr_second"));
    await flush();
    stopAgain();

    const stopThird = subscribeActivity(key, fetch, () => undefined);
    expect(calls).toHaveLength(3);
    stopThird();
    calls[2].resolve(result("thr_dropped"));
    await flush();
    expect(readActivity(key)).toBeNull();
  });

  it("publishes the empty response when the fetch rejects", async () => {
    const key = keyFor("failing");
    const { calls, fetch } = fakeFetch();
    const unsubscribe = subscribeActivity(key, fetch, () => undefined);

    calls[0].reject(new Error("timeline unavailable"));
    await flush();

    expect(readActivity(key)).toBe(EMPTY_RESPONSE);

    unsubscribe();
  });

  it("keeps two keys apart", async () => {
    const leftKey = keyFor("left");
    const rightKey = keyFor("right");
    const left = fakeFetch();
    const right = fakeFetch();
    const stopLeft = subscribeActivity(leftKey, left.fetch, () => undefined);
    const stopRight = subscribeActivity(rightKey, right.fetch, () => undefined);

    expect(left.calls).toHaveLength(1);
    expect(right.calls).toHaveLength(1);

    const leftPayload = result("thr_left");
    left.calls[0].resolve(leftPayload);
    await flush();

    expect(readActivity(leftKey)).toBe(leftPayload);
    expect(readActivity(rightKey)).toBeNull();

    refreshActivity(leftKey);
    await flush();

    expect(left.calls).toHaveLength(2);
    expect(right.calls).toHaveLength(1);

    stopLeft();
    stopRight();
  });
});
