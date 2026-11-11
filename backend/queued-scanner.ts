import { randomUUID } from "node:crypto";
import { TaskStore } from "./task-store.ts";
import type { Publisher } from "./pubsub.ts";
import { AppError } from "./types.ts";

export class QueuedScanner {
  constructor(
    readonly tasks: TaskStore,
    private publisher: Publisher,
    readonly intervalMs: number,
    private cooldownMs = 60000,
  ) {}
  async dispatch() {
    const pending = await this.tasks.outbox();
    try {
      await this.publisher.publish(
        pending.map((t) => ({ version: 1, taskId: t.id })),
      );
      // A crash here can republish; task IDs and atomic completion make that safe.
      for (const task of pending) await this.tasks.published(task.id);
    } catch {
      console.error(
        JSON.stringify({ event: "publish_failed", count: pending.length }),
      );
      throw new AppError("PUBLISH_FAILED", "", 503);
    }
  }
  async scan(manual = false, key = `manual:${randomUUID()}`) {
    // Durable outbox recovery also runs on each existing hourly Scheduler request.
    await this.dispatch();
    const batchId = await this.tasks.create(key, manual ? this.cooldownMs : 0);
    await this.dispatch();
    console.log(JSON.stringify({ event: "scan_queued", batchId, run: key }));
    return { accepted: true as const, batchId };
  }
  async persistentStatus() {
    return {
      ...(await this.tasks.status()),
      nextScanAt: null,
      intervalMinutes: this.intervalMs / 60000,
    };
  }
  start() {
    throw new Error("Pub/Sub requires external scheduling");
  }
  async stop() {}
}
