import type { Repository } from "./db.ts";
import type { Collector } from "./collector.ts";
import { AppError, errorCode } from "./types.ts";
import { randomUUID } from "node:crypto";
import { ScanStore } from "./scan-store.ts";

export type ScanResult = {
  added: number;
  succeeded: number;
  failed: number;
  checked: number;
};
export class Scanner {
  running = false;
  lastFinishedAt: string | null = null;
  lastResult: ScanResult | null = null;
  nextScanAt: string | null = null;
  private active: Promise<ScanResult> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private store: ScanStore;
  private abort?: AbortController;
  constructor(
    private repo: Repository,
    private collector: Collector,
    readonly intervalMs: number,
    private minRefreshMs = 60000,
  ) {
    this.store = new ScanStore(repo);
  }
  scan(manual = false, runKey = `local:${randomUUID()}`): Promise<ScanResult> {
    if (this.active) {
      if (runKey.startsWith("scheduled:"))
        return Promise.reject(new AppError("SCAN_IN_PROGRESS", "", 409));
      return this.active;
    }
    this.running = true;
    this.active = this.coordinatedRun(runKey, manual).finally(() => {
      this.running = false;
      this.active = null;
    });
    return this.active;
  }
  private async coordinatedRun(key: string, manual: boolean) {
    const lock = await this.store.acquire(key, manual ? this.minRefreshMs : 0);
    if (lock.cached) return lock.cached;
    const owner = lock.owner!;
    this.abort = new AbortController();
    const timeout = setTimeout(() => this.abort?.abort(), 240000);
    timeout.unref();
    let lost = false;
    const heartbeat = setInterval(() => {
      void this.store.renew(owner).catch(() => {
        lost = true;
        this.abort?.abort();
      });
    }, 20000);
    heartbeat.unref();
    console.log(JSON.stringify({ event: "scan_started", run: key }));
    try {
      const result = await this.run(owner, () => lost, this.abort.signal);
      await this.store.finish(owner, key, result);
      this.lastResult = result;
      this.lastFinishedAt = new Date().toISOString();
      console.log(
        JSON.stringify({ event: "scan_finished", run: key, ...result }),
      );
      return result;
    } catch (error) {
      await this.store.finish(owner, key, null).catch(() => {});
      console.error(
        JSON.stringify({
          event: "scan_failed",
          run: key,
          code: errorCode(error),
        }),
      );
      throw error;
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      this.abort = undefined;
    }
  }
  private async run(owner: string, lost: () => boolean, signal: AbortSignal) {
    const result = { added: 0, succeeded: 0, failed: 0, checked: 0 };
    const deadline = Date.now() + 240000;
    for (const source of await this.repo.sources()) {
      if (lost() || Date.now() > deadline)
        throw new AppError("SCAN_INTERRUPTED", "", 503);
      result.checked++;
      try {
        const list = await this.collector.collect(source, signal);
        signal.throwIfAborted();
        if (lost()) throw new AppError("SCAN_LEASE_LOST", "", 503);
        result.added += await this.repo.saveScan(source.id, list, owner);
        result.succeeded++;
      } catch (error) {
        if (
          signal.aborted ||
          lost() ||
          (error instanceof AppError && error.code === "SCAN_LEASE_LOST")
        )
          throw error;
        result.failed++;
        await this.repo.failed(source.id, errorCode(error), owner);
        console.error(
          JSON.stringify({
            event: "source_failed",
            source: source.id,
            code: errorCode(error),
          }),
        );
      }
      await this.store.progress(owner, result.checked);
    }
    this.lastResult = result;
    this.lastFinishedAt = new Date().toISOString();
    return result;
  }
  start() {
    this.stopped = false;
    const schedule = (delay: number) => {
      this.nextScanAt = new Date(Date.now() + delay).toISOString();
      this.timer = setTimeout(async () => {
        this.nextScanAt = null;
        try {
          await this.scan();
        } catch {
          console.error("Scheduled scan failed; database may be unavailable.");
        }
        if (!this.stopped) schedule(this.intervalMs);
      }, delay);
      this.timer.unref();
    };
    schedule(1000);
  }
  async stop() {
    this.stopped = true;
    this.abort?.abort();
    clearTimeout(this.timer);
    this.nextScanAt = null;
    if (this.active) await this.active.catch(() => {});
  }
  status() {
    return {
      scanning: this.running,
      lastFinishedAt: this.lastFinishedAt,
      lastResult: this.lastResult,
      nextScanAt: this.nextScanAt,
      intervalMinutes: this.intervalMs / 60000,
    };
  }
  async persistentStatus() {
    return { ...this.status(), ...(await this.store.status()) };
  }
}
