import pg from "pg";
import { config } from "./config.ts";
import { Repository } from "./db.ts";
if (!config.databaseUrl) throw new Error("DATABASE_URL is required in .env");
const pool = new pg.Pool({ connectionString: config.databaseUrl });
try {
  await new Repository(pool).migrate();
  console.log("Database schema is ready.");
} finally {
  await pool.end();
}
