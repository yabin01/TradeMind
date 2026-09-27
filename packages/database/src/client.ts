import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = ReturnType<typeof createDb>['db'];

export const DEFAULT_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://trademind:trademind@localhost:5432/trademind';

export function createDb(url: string = DEFAULT_DATABASE_URL) {
  const sql = postgres(url, { max: 10 });
  return { db: drizzle(sql, { schema }), sql };
}
