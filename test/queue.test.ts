import { describe, expect, it } from "vitest";
import { KeyedQueue } from "../src/queue.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("KeyedQueue", () => {
  it("runs tasks for the same key sequentially", async () => {
    const queue = new KeyedQueue();
    const log: string[] = [];
    const a = queue.enqueue("k", async () => {
      log.push("a:start");
      await tick();
      log.push("a:end");
    });
    const b = queue.enqueue("k", async () => {
      log.push("b:start");
    });
    await Promise.all([a, b]);
    expect(log).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("runs tasks for different keys concurrently", async () => {
    const queue = new KeyedQueue();
    const log: string[] = [];
    const a = queue.enqueue("k1", async () => {
      log.push("a:start");
      await tick();
      log.push("a:end");
    });
    const b = queue.enqueue("k2", async () => {
      log.push("b:start");
    });
    await Promise.all([a, b]);
    expect(log).toEqual(["a:start", "b:start", "a:end"]);
  });

  it("keeps running later tasks after a failure", async () => {
    const queue = new KeyedQueue();
    const failed = queue.enqueue("k", async () => {
      throw new Error("x");
    });
    let ran = false;
    const next = queue.enqueue("k", async () => {
      ran = true;
    });
    await expect(failed).rejects.toThrow("x");
    await next;
    expect(ran).toBe(true);
  });
});
