import type pg from "pg";
import { readFileSync } from "node:fs";

export function databaseConfig(connectionString: string): pg.PoolConfig {
  const url = new URL(connectionString);
  const local = ["localhost", "127.0.0.1", "[::1]", "db"].includes(
    url.hostname,
  );
  // URL SSL options can override node-postgres' explicit certificate verification.
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert", "ssl"])
    url.searchParams.delete(key);
  return {
    connectionString: url.href,
    max: 5,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    ssl: local
      ? false
      : {
          rejectUnauthorized: true,
          ...(process.env.DATABASE_CA_FILE
            ? { ca: readFileSync(process.env.DATABASE_CA_FILE, "utf8") }
            : {}),
        },
  };
}
