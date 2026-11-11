import "dotenv/config";
import pg from "pg";
import { Repository } from "./db.ts";
import { databaseConfig } from "./database-config.ts";
import { Collector } from "./collector.ts";
import { CollectorHttp, createTransport } from "./network.ts";
import { TaskStore } from "./task-store.ts";
import { TaskWorker } from "./task-worker.ts";
import { createWorkerApp } from "./worker-app.ts";
import { schedulerVerifier } from "./security.ts";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const audience = required("PUBSUB_PUSH_AUDIENCE");
const email = required("PUBSUB_PUSH_SERVICE_ACCOUNT");
const subscription = required("PUBSUB_SUBSCRIPTION");
const deadSubscription = required("PUBSUB_DEAD_SUBSCRIPTION");
if (!audience.startsWith("https://") || new URL(audience).origin !== audience)
  throw new Error("Invalid PUBSUB_PUSH_AUDIENCE");
for (const name of [subscription, deadSubscription])
  if (
    !/^projects\/[a-z][a-z0-9-]+\/subscriptions\/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/.test(
      name,
    )
  )
    throw new Error("Invalid Pub/Sub subscription resource");
if (subscription === deadSubscription)
  throw new Error("Separate dead-letter subscription required");
const port = Number(process.env.PORT ?? 4311);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid PORT");
const pool = new pg.Pool(databaseConfig(required("DATABASE_URL")));
pool.on("error", () => console.error("Worker database connection failed"));
const repo = new Repository(pool);
await repo.migrate();
const worker = new TaskWorker(
  new TaskStore(repo),
  new Collector(new CollectorHttp(createTransport(12000))),
);
const server = createWorkerApp(worker, {
  subscription,
  deadSubscription,
  verify: schedulerVerifier(audience, email),
}).listen(port, process.env.HOST ?? "127.0.0.1", () =>
  console.log(JSON.stringify({ event: "worker_listening", port })),
);
server.requestTimeout = 300000;
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  const force = setTimeout(() => process.exit(1), 8500);
  force.unref();
  worker.stop();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
  clearTimeout(force);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
