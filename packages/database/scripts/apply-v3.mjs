// 应用 v3 schema 变更（幂等）：AI 教练 —— 会话 / 消息 / 记忆（问责）
// 运行：在 packages/database 目录下 node scripts/apply-v3.mjs
import postgres from 'postgres';

const url = process.env.DATABASE_URL ?? 'postgres://trademind:trademind@localhost:5432/trademind';
const sql = postgres(url, { max: 1 });

const ddl = `
CREATE TABLE IF NOT EXISTS coach_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  title text NOT NULL DEFAULT '新对话',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coach_sessions_ws_idx ON coach_sessions (workspace_id);

CREATE TABLE IF NOT EXISTS coach_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES coach_sessions (id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL,
  intent text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coach_messages_session_idx ON coach_messages (session_id);
CREATE INDEX IF NOT EXISTS coach_messages_ws_idx ON coach_messages (workspace_id);

CREATE TABLE IF NOT EXISTS coach_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  kind text NOT NULL,
  content text NOT NULL,
  metric text,
  threshold double precision,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coach_memory_ws_idx ON coach_memory (workspace_id);
`;

try {
  await sql.unsafe(ddl);
  const tables = await sql`select table_name from information_schema.tables where table_name in ('coach_sessions','coach_messages','coach_memory')`;
  console.log('[apply-v3] tables:', tables.map((t) => t.table_name).join(', '));
  console.log('[apply-v3] DDL applied OK');
} catch (e) {
  console.error('[apply-v3] FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
