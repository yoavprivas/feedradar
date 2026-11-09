import "dotenv/config";
function number(name: string, fallback: number, min: number, max: number) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n) || n < min || n > max)
    throw new Error(`Invalid ${name}`);
  return n;
}
export const config = {
  port: number("PORT", 4310, 1024, 65535),
  intervalMinutes: number("SCAN_INTERVAL_MINUTES", 30, 5, 1440),
  timeout: number("REQUEST_TIMEOUT_MS", 12000, 1000, 30000),
  minRefreshSeconds: number("MIN_REFRESH_SECONDS", 60, 10, 3600),
  databaseUrl: process.env.DATABASE_URL,
};
