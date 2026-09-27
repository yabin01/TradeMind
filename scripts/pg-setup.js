const postgres = require('../packages/database/node_modules/postgres');
const url = process.env.PGURL || 'postgres://trademind:trademind@localhost:5432/postgres';
(async () => {
  const sql = postgres(url, { connect_timeout: 5 });
  console.log('version:', (await sql`SELECT version()`)[0].version.slice(0, 30));
  await sql`CREATE DATABASE trademind`.catch((e) => console.log('create:', e.message));
  console.log('dbs:', (await sql`SELECT datname FROM pg_database`).map((r) => r.datname).join(','));
  await sql.end();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
