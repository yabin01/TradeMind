// 应用 v2 schema 变更（幂等）：入场/出场标签 + 归档 + Diary 笔记 + 筛选模板
// 运行：在 packages/database 目录下 node scripts/apply-v2.mjs
import postgres from 'postgres';

const url = process.env.DATABASE_URL ?? 'postgres://trademind:trademind@localhost:5432/trademind';
const sql = postgres(url, { max: 1 });

const ddl = `
ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS diary_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  scope text NOT NULL,
  period_key text NOT NULL,
  rating integer,
  content text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS diary_notes_scope_period_uq ON diary_notes (workspace_id, scope, period_key);

CREATE TABLE IF NOT EXISTS filter_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  filter jsonb NOT NULL DEFAULT '{}'::jsonb,
  favorite boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS filter_presets_ws_idx ON filter_presets (workspace_id);
`;

try {
  await sql.unsafe(ddl);
  console.log('[apply-v2] DDL applied OK');
  const cols = await sql`select column_name from information_schema.columns where table_name='trades' and column_name in ('entry_tags','exit_tags','archived')`;
  const tables = await sql`select table_name from information_schema.tables where table_name in ('diary_notes','filter_presets')`;
  console.log('[apply-v2] trades new columns:', cols.map((c) => c.column_name).join(', '));
  console.log('[apply-v2] new tables:', tables.map((t) => t.table_name).join(', '));
} catch (e) {
  console.error('[apply-v2] FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
