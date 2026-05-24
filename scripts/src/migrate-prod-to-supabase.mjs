#!/usr/bin/env node
/* eslint-disable no-console */
import pg from "/home/runner/workspace/lib/db/node_modules/pg/lib/index.js";

const SUPABASE_URL = process.env.SUPABASE_DATABASE_URL;
const PROD_URL = process.env.PROD_DATABASE_URL;
if (!SUPABASE_URL) throw new Error("SUPABASE_DATABASE_URL not set");
if (!PROD_URL) throw new Error("PROD_DATABASE_URL not set (the Replit prod DB connection string)");

const MAX_PARAMS = 30000; // Stay well under Postgres's 65535 (int16) param limit

const sb = new pg.Pool({ connectionString: SUPABASE_URL, max: 4 });
const prod = new pg.Pool({ connectionString: PROD_URL, max: 2, ssl: { rejectUnauthorized: false } });

function logStep(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function getColumns(pool) {
  const r = await pool.query(`
    SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_schema='public' ORDER BY table_name, ordinal_position
  `);
  const m = {};
  const types = {};
  const nullable = {};
  for (const row of r.rows) {
    (m[row.table_name] ??= []).push(row.column_name);
    (types[row.table_name] ??= {})[row.column_name] = row.data_type;
    (nullable[row.table_name] ??= {})[row.column_name] = row.is_nullable === "YES";
  }
  m.__types = types;
  m.__nullable = nullable;
  return m;
}

const INT_TYPES = new Set(["bigint", "integer", "smallint"]);
const FLOAT_TYPES = new Set(["real", "double precision", "numeric"]);
const JSON_TYPES = new Set(["json", "jsonb"]);

function coerceValue(val, prodType, sbType) {
  if (val === null || val === undefined) return val;
  // Float → Int: round
  if (FLOAT_TYPES.has(prodType) && INT_TYPES.has(sbType)) {
    const n = typeof val === "number" ? val : parseFloat(val);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  // JSON: always pass as string to avoid pg-node auto-stringify quirks
  if (JSON_TYPES.has(sbType)) {
    if (typeof val === "string") return val;
    try { return JSON.stringify(val); } catch { return null; }
  }
  return val;
}

function placeholderCast(sbType) {
  // When target is json/jsonb, force-cast the parameter so the server parses the string as JSON.
  if (sbType === "jsonb") return "::jsonb";
  if (sbType === "json")  return "::json";
  return "";
}

async function getCounts(pool) {
  const r = await pool.query(`
    SELECT table_name, (xpath('/row/c/text()',
      query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint AS c
    FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE'
  `);
  const m = {};
  for (const row of r.rows) m[row.table_name] = Number(row.c);
  return m;
}

async function getTablesInPkOrder(pool, table) {
  // Find primary key columns for stable ordering during pagination
  const r = await pool.query(
    `SELECT a.attname AS col
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = $1::regclass AND i.indisprimary
     ORDER BY array_position(i.indkey, a.attnum)`,
    [`public.${table}`],
  );
  return r.rows.map(r => r.col);
}

function quoteIdent(s) {
  return `"${s.replace(/"/g, '""')}"`;
}

async function copyTable(table, commonCols, sbClient, prodTypes, sbTypes) {
  const cols = commonCols.map(quoteIdent).join(",");
  const pkCols = await getTablesInPkOrder(prod, table);
  const orderBy = pkCols.length
    ? pkCols.map(quoteIdent).join(",")
    : "ctid";
  const batch = Math.max(1, Math.floor(MAX_PARAMS / commonCols.length));

  let offset = 0;
  let total = 0;
  for (;;) {
    const sel = `SELECT ${cols} FROM public.${quoteIdent(table)} ORDER BY ${orderBy} LIMIT ${batch} OFFSET ${offset}`;
    const r = await prod.query(sel);
    if (r.rows.length === 0) break;

    const params = [];
    const valuesSql = r.rows.map((row, ri) => {
      const ph = commonCols.map((c, ci) => {
        params.push(coerceValue(row[c], prodTypes[c], sbTypes[c]));
        return `$${ri * commonCols.length + ci + 1}${placeholderCast(sbTypes[c])}`;
      });
      return `(${ph.join(",")})`;
    }).join(",");
    const insert = `INSERT INTO public.${quoteIdent(table)} (${cols}) VALUES ${valuesSql}`;
    try {
      await sbClient.query(insert, params);
    } catch (e) {
      console.error(`  ✗ ${table}: failed at offset ${offset}, batch=${batch}, cols=${commonCols.length}, params=${params.length}`);
      throw e;
    }

    total += r.rows.length;
    offset += batch;
    if (r.rows.length < batch) break;
  }
  return total;
}

async function main() {
  logStep("Loading schema info from both DBs...");
  const [sbCols, prodCols, prodCounts] = await Promise.all([
    getColumns(sb), getColumns(prod), getCounts(prod),
  ]);

  // Tables to copy: populated in prod AND exist in Supabase
  const populated = Object.entries(prodCounts)
    .filter(([t, c]) => c > 0 && sbCols[t])
    .sort((a, b) => b[1] - a[1]);

  const skipped = Object.entries(prodCounts)
    .filter(([t, c]) => c > 0 && !sbCols[t]);

  console.log(`\nPlan:`);
  console.log(` - Tables to copy: ${populated.length}`);
  console.log(` - Total rows: ${populated.reduce((s, [, c]) => s + c, 0)}`);
  console.log(` - Skipped (in prod but not in Supabase): ${skipped.length ? skipped.map(s => s[0]).join(", ") : "none"}`);

  // Per-table column intersection
  const plan = populated.map(([t, c]) => {
    const pset = new Set(prodCols[t]);
    const common = sbCols[t].filter(col => pset.has(col));
    const onlyProd = prodCols[t].filter(col => !sbCols[t].includes(col));
    return { table: t, rows: c, common, onlyProd };
  });
  const drifted = plan.filter(p => p.onlyProd.length);
  if (drifted.length) {
    console.log(`\nSchema drift (prod columns NOT in Supabase — these values will be dropped):`);
    for (const d of drifted) console.log(` - ${d.table}: dropping [${d.onlyProd.join(", ")}]`);
  }

  // === Auto-align Supabase column types to match prod where they differ ===
  // The Drizzle-pushed Supabase schema disagrees with the actual prod data
  // shape on some columns. Without this, the copy fails on type mismatches
  // (e.g. text "system" → bigint). Strategy: ALTER Supabase column types
  // to match prod.
  const sbAdminClient = await sb.connect();
  try {
    // Only ALTER when the type mismatch would actually fail the copy.
    // pg handles bigint↔integer, real↔double, timestamp↔timestamptz, and
    // enum→text natively. The breaking case is text/varchar in prod going
    // into a non-text column in Supabase (e.g. guild_id = "system" → bigint).
    const TEXT_TYPES = new Set(["text", "character varying", "character", "varchar"]);
    const typeFixes = [];
    for (const p of plan) {
      const pt = prodCols.__types[p.table] || {};
      const st = sbCols.__types[p.table] || {};
      for (const col of p.common) {
        const prodT = pt[col], sbT = st[col];
        if (!prodT || !sbT || prodT === sbT) continue;
        // Need ALTER: prod is text-like, Supabase is non-text-like
        if (TEXT_TYPES.has(prodT) && !TEXT_TYPES.has(sbT)) {
          typeFixes.push({ table: p.table, col, prodType: prodT, sbType: sbT, action: "to_text" });
        }
        // Supabase is uuid but prod isn't → ALTER Supabase to text (uuid can't accept integers)
        else if (sbT === "uuid" && prodT !== "uuid") {
          typeFixes.push({ table: p.table, col, prodType: prodT, sbType: sbT, action: "to_text" });
        }
        // Boolean compatibility: prod boolean, supabase text → leave (text accepts "true"/"false")
        // Boolean compatibility: prod text, supabase boolean → ALTER supabase to text
      }
    }
    if (typeFixes.length) {
      logStep(`Aligning ${typeFixes.length} column types in Supabase to match prod (text-incompatible only):`);
      for (const f of typeFixes) {
        console.log(`  • ${f.table}.${f.col}: ${f.sbType} → text`);
        try {
          await sbAdminClient.query(
            `ALTER TABLE public.${quoteIdent(f.table)} ALTER COLUMN ${quoteIdent(f.col)} TYPE text USING ${quoteIdent(f.col)}::text`,
          );
        } catch (e) {
          console.error(`    ⚠ ALTER failed: ${e.message}`);
          throw e;
        }
      }
    } else {
      logStep("No text-incompatible type mismatches to fix.");
    }

    // Drop NOT NULL on Supabase columns where prod allows null (otherwise valid prod rows can't be inserted).
    const nullFixes = [];
    for (const p of plan) {
      const pn = prodCols.__nullable[p.table] || {};
      const sn = sbCols.__nullable[p.table] || {};
      for (const col of p.common) {
        if (pn[col] === true && sn[col] === false) {
          nullFixes.push({ table: p.table, col });
        }
      }
    }
    if (nullFixes.length) {
      logStep(`Dropping NOT NULL on ${nullFixes.length} Supabase columns (prod allows null):`);
      for (const f of nullFixes) {
        console.log(`  • ${f.table}.${f.col}: DROP NOT NULL`);
        await sbAdminClient.query(
          `ALTER TABLE public.${quoteIdent(f.table)} ALTER COLUMN ${quoteIdent(f.col)} DROP NOT NULL`,
        );
      }
    }

    if (typeFixes.length || nullFixes.length) {
      const refreshed = await getColumns(sb);
      sbCols.__types = refreshed.__types;
      sbCols.__nullable = refreshed.__nullable;
    }
  } finally {
    sbAdminClient.release();
  }

  // === DESTRUCTIVE OPS BELOW ===
  const sbClient = await sb.connect();
  try {
    logStep("\nDisabling FK triggers on Supabase session...");
    await sbClient.query("SET session_replication_role = replica");

    // Check what's already there — resume mode if any table has rows
    const sbCountsPre = await getCounts(sb);
    const alreadyDone = plan.filter(p => sbCountsPre[p.table] === p.rows);
    const remaining = plan.filter(p => sbCountsPre[p.table] !== p.rows);
    if (alreadyDone.length) {
      logStep(`Resume mode: ${alreadyDone.length} tables already match prod, will skip.`);
      for (const p of alreadyDone) console.log(`  ⏭  ${p.table}: ${p.rows} rows already in Supabase`);
    }

    // Truncate only the tables we still need to copy (those that don't match)
    if (remaining.length > 0) {
      const truncTables = remaining.map(p => `public.${quoteIdent(p.table)}`).join(", ");
      logStep(`Truncating ${remaining.length} Supabase tables (RESTART IDENTITY CASCADE)...`);
      await sbClient.query(`TRUNCATE ${truncTables} RESTART IDENTITY CASCADE`);
    }

    // Copy each table that still needs copying
    for (const p of remaining) {
      const start = Date.now();
      const copied = await copyTable(p.table, p.common, sbClient, prodCols.__types[p.table] || {}, sbCols.__types[p.table] || {});
      const ms = Date.now() - start;
      const status = copied === p.rows ? "✓" : `⚠ expected ${p.rows}`;
      logStep(`  ${status} ${p.table}: ${copied} rows in ${ms}ms`);
    }

    logStep("\nRe-enabling FK triggers on Supabase...");
    await sbClient.query("SET session_replication_role = origin");

    // Reset sequences to MAX(id)+1 for every Supabase table that has a serial PK
    logStep("Resetting Supabase sequences...");
    const seqRes = await sbClient.query(`
      SELECT
        n.nspname AS schema,
        c.relname AS table,
        a.attname AS col,
        pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) AS seq
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) IS NOT NULL
    `);
    let seqCount = 0;
    for (const row of seqRes.rows) {
      const maxRes = await sbClient.query(`SELECT COALESCE(MAX(${quoteIdent(row.col)}), 0) AS m FROM public.${quoteIdent(row.table)}`);
      const next = Number(maxRes.rows[0].m) + 1;
      await sbClient.query(`SELECT setval($1, $2, false)`, [row.seq, next]);
      seqCount++;
    }
    logStep(`  reset ${seqCount} sequences`);
  } finally {
    sbClient.release();
  }

  // Verify
  logStep("\nVerifying row counts...");
  const sbCounts = await getCounts(sb);
  let pass = 0, mismatch = 0;
  for (const p of plan) {
    if (sbCounts[p.table] === p.rows) pass++;
    else {
      console.log(`  ✗ ${p.table}: prod=${p.rows} supabase=${sbCounts[p.table]}`);
      mismatch++;
    }
  }
  console.log(`\nResult: ${pass}/${plan.length} tables match (${mismatch} mismatch).`);

  await sb.end();
  await prod.end();
}

main().catch(e => { console.error(e); process.exit(1); });
