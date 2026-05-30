import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as discordEconomySchema from "./schema/discord-economy";
import * as mcaNativeSchema from "./schema/mca-native";

const connectionString =
  process.env.SUPABASE_DATABASE_URL ??
  process.env.DATABASE_URL ??
  process.env.POSTGRES_URL;

if (!connectionString) {
  throw new Error(
    "SUPABASE_DATABASE_URL (preferred) or DATABASE_URL must be set.",
  );
}

export const pool = new Pool({
  connectionString,
  max: Number(process.env.DB_POOL_MAX ?? 10),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS ?? 30_000),
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS ?? 10_000),
});

export const db = drizzle(pool, {
  schema: {
    ...discordEconomySchema,
    ...mcaNativeSchema,
  },
});

export * from "./schema/discord-economy";
export * from "./schema/mca-native";