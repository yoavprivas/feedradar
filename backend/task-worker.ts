import type { Collector } from "./collector.ts";
import { TaskStore } from "./task-store.ts";
import { errorCode } from "./types.ts";

export class TaskWorker {
  private active = new Set<AbortController>();
  private closing = false;
  constructor(
    readonly tasks: TaskStore,
    private collector: Collector,
  ) {}
  async process(id: string) {
    if (this.closing) throw new Error("Worker is shutting down");
    const claim = await this.tasks.claim(id);
    if (!claim) {
      console.log(JSON.stringify({ event: "task_duplicate", taskId: id }));
      return;
    }
    const abort = new AbortController();
    this.active.add(abort);
    const timeout = setTimeout(() => abort.abort(), 240000);
    timeout.unref();
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.tasks
        .renew(id, claim.owner)
        .catch(() => abort.abort())
        .finally(() => {
          renewing = false;
        });
    }, 20000);
    heartbeat.unref();
    console.log(
      JSON.stringify({
        event: "task_started",
        taskId: id,
        source: claim.sourceId,
        attempt: claim.attempt,
      }),
    );
    try {
      const source = await this.tasks.repo.source(claim.sourceId);
      const entries = source
        ? await this.collector.collect(source, abort.signal)
        : [];
      abort.signal.throwIfAborted();
      const added = await this.tasks.repo.saveScan(
        claim.sourceId,
        entries,
        undefined,
        { id, owner: claim.owner },
      );
      console.log(
        JSON.stringify({ event: "task_complete", taskId: id, added }),
      );
    } catch (error) {
      const code = errorCode(error);
      await this.tasks.fail(id, claim.owner, code).catch(() => {});
      console.error(
        JSON.stringify({
          event: "task_failed",
          taskId: id,
          attempt: claim.attempt,
          code,
        }),
      );
      throw error;
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      this.active.delete(abort);
    }
  }
  stop() {
    this.closing = true;
    for (const abort of this.active) abort.abort();
  }
}
