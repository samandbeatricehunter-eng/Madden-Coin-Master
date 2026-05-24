---
name: Replit DATABASE_URL is reserved
description: Replit owns the DATABASE_URL secret for its built-in Postgres; requestEnvVar refuses it. Use a separate name when switching to an external DB.
---

`DATABASE_URL` is auto-populated by Replit when a built-in Postgres database is provisioned. The platform refuses `requestEnvVar({ keys: ["DATABASE_URL"] })` with: "directly populated by Replit from the user's account and should not be requested". Even the user cannot reliably override it from the Secrets UI in some workspaces — the slot may not appear, or it gets reset.

**Why:** Replit's database integration treats DATABASE_URL as a managed value tied to the provisioned database.

**How to apply:** When migrating to an external DB (Supabase, Neon, RDS, etc.), don't try to overwrite DATABASE_URL. Request a separate secret like `SUPABASE_DATABASE_URL` / `NEON_DATABASE_URL`, and update the DB connection module (and any drizzle/prisma config) to prefer the external var with `DATABASE_URL` as fallback:

```ts
const connectionString =
  process.env.SUPABASE_DATABASE_URL ?? process.env.DATABASE_URL;
```

This keeps local Replit Postgres working as a fallback (useful in scaffolding/seed scripts) while production points at the external DB.
