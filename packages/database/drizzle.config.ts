import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema.ts',
  out: '../../migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgres://trademind:trademind@localhost:5432/trademind',
  },
} satisfies Config;
