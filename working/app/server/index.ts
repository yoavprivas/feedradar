import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import { Repository } from "./db.ts";
import { CollectorHttp, createTransport } from "./network.ts";
import { Collector } from "./collector.ts";
import { Scanner } from "./scanner.ts";
import { createApp } from "./app.ts";

if (!config.databaseUrl)
  throw new Error(
    "DATABASE_URL is required. Copy .env.example to .env and configure PostgreSQL.",
  );
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 5,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
pool.on("error", () => console.error("Idle database connection failed."));
const repo = new Repository(pool);
await repo.migrate();
const collector = new Collector(
  new CollectorHttp(createTransport(config.timeout)),
);
const scanner = new Scanner(
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
);
const server = app.listen(config.port, "127.0.0.1", () => {
  console.log(`FeedRadar: http://127.0.0.1:${config.port}`);
  scanner.start();
});
server.requestTimeout = 180000;
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  await scanner.stop();
  await pool.end();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
