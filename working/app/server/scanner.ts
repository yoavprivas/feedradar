import type { Repository } from "./db.ts";
import type { Collector } from "./collector.ts";
import { AppError, errorCode } from "./types.ts";

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
  private lastStarted = 0;
  constructor(
    private repo: Repository,
    private collector: Collector,
    readonly intervalMs: number,
    private minRefreshMs = 60000,
  ) {}
  scan(manual = false): Promise<ScanResult> {
    if (this.active) return this.active;
    if (manual && Date.now() - this.lastStarted < this.minRefreshMs)
      throw new AppError("REFRESH_COOLDOWN", "", 429);
    this.lastStarted = Date.now();
    this.running = true;
    this.active = this.run().finally(() => {
      this.running = false;
      this.active = null;
    });
    return this.active;
  }
  private async run() {
    const result = { added: 0, succeeded: 0, failed: 0, checked: 0 };
    for (const source of await this.repo.sources()) {
      result.checked++;
      try {
        const list = await this.collector.collect(source);
        result.added += await this.repo.saveScan(source.id, list);
        result.succeeded++;
      } catch (error) {
        result.failed++;
        await this.repo.failed(source.id, errorCode(error));
      }
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
}
