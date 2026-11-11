import "dotenv/config";
function number(name: string, fallback: number, min: number, max: number) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`Invalid ${name}`);
  return n;
}
export const config = {
  port: number("PORT", 4310, 1024, 65535),
  intervalMinutes: number("SCAN_INTERVAL_MINUTES", 30, 5, 1440),
  timeout: number("REQUEST_TIMEOUT_MS", 12000, 1000, 30000),
  minRefreshSeconds: number("MIN_REFRESH_SECONDS", 60, 10, 3600),
  databaseUrl: process.env.DATABASE_URL,
  host: process.env.HOST ?? "127.0.0.1",
  schedulerMode: process.env.SCHEDULER_MODE ?? "local",
  publicOrigin: process.env.PUBLIC_ORIGIN,
  authMode: process.env.AUTH_MODE ?? "local",
  passwordHash: process.env.ADMIN_PASSWORD_HASH,
  schedulerAudience: process.env.SCHEDULER_AUDIENCE,
  schedulerEmail: process.env.SCHEDULER_SERVICE_ACCOUNT,
  schedulerJob: process.env.SCHEDULER_JOB_NAME,
  scanMode: process.env.SCAN_MODE ?? "sync",
  pubsubTopic: process.env.PUBSUB_TOPIC,
  redisUrl: process.env.UPSTASH_REDIS_REST_URL?.trim(),
  redisToken: process.env.UPSTASH_REDIS_REST_TOKEN?.trim(),
  cacheNamespace: process.env.CACHE_NAMESPACE,
  cacheTtlSeconds: number("CACHE_TTL_SECONDS", 60, 10, 300),
  cacheTimeoutMs: number("CACHE_TIMEOUT_MS", 500, 50, 2000),
};
if (!!config.redisUrl !== !!config.redisToken)
  throw new Error("Redis needs both REST URL and token");
if (config.redisUrl && !config.cacheNamespace)
  throw new Error("Redis needs a distinct CACHE_NAMESPACE");
if (!["sync", "pubsub"].includes(config.scanMode))
  throw new Error("Invalid SCAN_MODE");
if (
  config.scanMode === "pubsub" &&
  (!config.pubsubTopic || config.schedulerMode !== "external")
)
  throw new Error("Pub/Sub requires PUBSUB_TOPIC and SCHEDULER_MODE=external");
if (!["local", "external"].includes(config.schedulerMode))
  throw new Error("Invalid SCHEDULER_MODE");
if (!["local", "password"].includes(config.authMode))
  throw new Error("Invalid AUTH_MODE");
if (config.publicOrigin) {
  const url = new URL(config.publicOrigin);
  if (
    url.origin !== config.publicOrigin ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new Error("Invalid PUBLIC_ORIGIN");
}
if (
  config.authMode === "password" &&
  (!config.passwordHash || !config.publicOrigin)
)
  throw new Error(
    "Password authentication needs ADMIN_PASSWORD_HASH and PUBLIC_ORIGIN",
  );
if (
  process.env.K_SERVICE &&
  (config.authMode !== "password" ||
    !config.publicOrigin?.startsWith("https://") ||
    config.schedulerMode !== "external")
)
  throw new Error(
    "Cloud Run requires HTTPS, password authentication and external scheduling",
  );
if (
  process.env.K_SERVICE &&
  (!config.schedulerAudience || !config.schedulerEmail || !config.schedulerJob)
)
  throw new Error(
    "Cloud Run requires complete Scheduler identity configuration",
  );
if (
  config.publicOrigin &&
  !["localhost", "127.0.0.1", "[::1]"].includes(
    new URL(config.publicOrigin).hostname,
  ) &&
  (config.authMode !== "password" ||
    !config.publicOrigin.startsWith("https://"))
)
  throw new Error("Public origins require HTTPS and password authentication");
