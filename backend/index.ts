import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import { Repository } from "./db.ts";
import { CollectorHttp, createTransport } from "./network.ts";
import { Collector } from "./collector.ts";
import { Scanner } from "./scanner.ts";
import { createApp } from "./app.ts";
import { databaseConfig } from "./database-config.ts";
import { TaskStore } from "./task-store.ts";
import { PubSubPublisher } from "./pubsub.ts";
import { QueuedScanner } from "./queued-scanner.ts";

if (!config.databaseUrl)
  throw new Error(
    "DATABASE_URL is required. Copy .env.example to .env and configure PostgreSQL.",
  );
const pool = new pg.Pool(databaseConfig(config.databaseUrl));
pool.on("error", () => console.error("Idle database connection failed."));
const repo = new Repository(pool);
await repo.migrate();
const collector = new Collector(
  new CollectorHttp(createTransport(config.timeout)),
);
const scanner =
  config.scanMode === "pubsub"
    ? new QueuedScanner(
        new TaskStore(repo),
        new PubSubPublisher(config.pubsubTopic!),
        config.intervalMinutes * 60000,
        config.minRefreshSeconds * 1000,
      )
    : new Scanner(
        repo,
        collector,
        config.intervalMinutes * 60000,
        config.minRefreshSeconds * 1000,
      );
const app = createApp(
  repo,
  collector,
  scanner,
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist"),
  config,
);
const server = app.listen(config.port, config.host, () => {
  console.log(
    JSON.stringify({
      event: "listening",
      port: config.port,
      scheduler: config.schedulerMode,
    }),
  );
  if (config.schedulerMode === "local") scanner.start();
});
server.requestTimeout = 180000;
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const force = setTimeout(() => process.exit(1), 8500);
  force.unref();
  await Promise.all([
    new Promise<void>((resolve) => server.close(() => resolve())),
    scanner.stop(),
  ]);
  await pool.end();
  clearTimeout(force);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
