#!/usr/bin/env node
/* eslint-disable no-console */
import pg from "pg";
import { spawn } from "node:child_process";

const SUPABASE_URL = process.env.SUPABASE_DATABASE_URL;
const PROD_URL = process.env.PROD_DATABASE_URL;
if (!SUPABASE_URL) throw new Error("SUPABASE_DATABASE_URL not set");
if (!PROD_URL) throw new Error("PROD_DATABASE_URL not set (the Replit prod DB connection string)");

const BATCH = 1000;

const sb = new pg.Pool({ connectionString: SUPABASE_URL, max: 4 });
const prod = new pg.Pool({ connectionString: PROD_URL, max: 2, ssl: { rejectUnauthorized: false } });

function logStep(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function getColumns(pool) {
  const r = await pool.query(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema='public' ORDER BY table_name, ordinal_position
  `);
  const m = {};
  for (const row of r.rows) (m[row.table_name] ??= []).push(row.column_name);
  return m;
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

async function copyTable(table, commonCols, sbClient) {
  const cols = commonCols.map(quoteIdent).join(",");
  const pkCols = await getTablesInPkOrder(prod, table);
  const orderBy = pkCols.length
    ? pkCols.map(quoteIdent).join(",")
    : "ctid";

  let offset = 0;
  let total = 0;
  for (;;) {
    const sel = `SELECT ${cols} FROM public.${quoteIdent(table)} ORDER BY ${orderBy} LIMIT ${BATCH} OFFSET ${offset}`;
    const r = await prod.query(sel);
    if (r.rows.length === 0) break;

    // Build multi-row INSERT with parameters
    const params = [];
    const valuesSql = r.rows.map((row, ri) => {
      const ph = commonCols.map((c, ci) => {
        params.push(row[c]);
        return `$${ri * commonCols.length + ci + 1}`;
      });
      return `(${ph.join(",")})`;
    }).join(",");
    const insert = `INSERT INTO public.${quoteIdent(table)} (${cols}) VALUES ${valuesSql}`;
    await sbClient.query(insert, params);

    total += r.rows.length;
    offset += BATCH;
    if (r.rows.length < BATCH) break;
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

  // === DESTRUCTIVE OPS BELOW ===
  const sbClient = await sb.connect();
  try {
    logStep("\nDisabling FK triggers on Supabase session...");
    await sbClient.query("SET session_replication_role = replica");

    // Truncate all Supabase populated tables (those we're about to write to)
    // Use CASCADE to handle FKs from other tables
    const truncTables = plan.map(p => `public.${quoteIdent(p.table)}`).join(", ");
    logStep(`Truncating ${plan.length} Supabase tables (RESTART IDENTITY CASCADE)...`);
    await sbClient.query(`TRUNCATE ${truncTables} RESTART IDENTITY CASCADE`);

    // Copy each table
    for (const p of plan) {
      const start = Date.now();
      const copied = await copyTable(p.table, p.common, sbClient);
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
