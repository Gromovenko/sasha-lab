#!/usr/bin/env node
// Накатывание миграций: db/migrations/*.sql по возрастанию имени, каждая один
// раз. Своего фреймворка тут не заводим — файлы и таблица с отметками.
const fs = require('fs');
const path = require('path');
const db = require('../seo/lib/db');

const DIR = path.join(__dirname, 'migrations');

async function migrate() {
  await db.q(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.q('SELECT version FROM schema_migrations')).map((r) => r.version));
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  let applied = 0;
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    await db.tx(async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
    });
    console.log(`  накачено: ${f}`);
    applied++;
  }
  console.log(applied ? `миграций накачено: ${applied}` : 'миграции: всё на месте');
}

if (require.main === module) {
  migrate().then(() => db.close()).catch((e) => { console.error('миграция упала:', e.message); process.exit(1); });
}
module.exports = { migrate };
