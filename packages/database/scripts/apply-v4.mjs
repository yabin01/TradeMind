// 应用 v4 schema 变更（幂等）：持仓标注 —— 给实时持仓补入场理由 / 标签 / 备注
// 运行：在 packages/database 目录下 node scripts/apply-v4.mjs
import postgres from 'postgres';

const url = process.env.DATABASE_URL ?? 'postgres://trademind:trademind@localhost:5432/trademind';
const sql = postgres(url, { max: 1 });

const ddl = `
CREATE TABLE IF NOT EXISTS position_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  symbol text NOT NULL,
  position_side text NOT NULL,
  entry_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS position_notes_key_uq
  ON position_notes (workspace_id, account_id, symbol, position_side);
CREATE INDEX IF NOT EXISTS position_notes_ws_idx ON position_notes (workspace_id);
`;

try {
  await sql.unsafe(ddl);
  const tables = await sql`select table_name from information_schema.tables where table_name in ('position_notes')`;
  console.log('[apply-v4] tables:', tables.map((t) => t.table_name).join(', '));
  console.log('[apply-v4] DDL applied OK');
} catch (e) {
  console.error('[apply-v4] FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
