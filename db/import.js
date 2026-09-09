#!/usr/bin/env node
// Перенос в базу того, что раньше лежало файлами:
//   content/kb/*.md          → materials
//   seo/data/questions.json  → questions
//   seo/data/keywords.json   → keywords
//   seo/data/positions.json  → positions
//
// Идемпотентно: гонять можно сколько угодно. Материалы и вопросы сверяются по
// ключу, снимки позиций — по паре (дата, движок, фраза), чтобы повторный запуск
// не раздувал историю дублями.
const fs = require('fs');
const path = require('path');
// Доступы лежат в seo/.env вне git; ни pm2, ни голый node их сами не читают,
// а нужны они и серверу, и командам — отсюда общий загрузчик.
require('../server-env')(require('path').join(__dirname, '..', 'seo', '.env'));
const db = require('../seo/lib/db');
const materials = require('../content/materials');
const { parseFile } = require('../content/parse');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'seo', 'data');

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

async function importMaterials() {
  const docs = materials.fromFiles();
  for (const d of docs) await materials.upsert(d.meta, d.body);
  return docs.length;
}

async function importQuestions() {
  const rows = readJson(path.join(DATA, 'questions.json'), []);
  for (const q of rows) {
    await db.q(
      `INSERT INTO questions (id, created_at, name, contact, car, text, ip, status, slug, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
      [q.id, q.at || new Date().toISOString(), q.name || '—', q.contact || '—', q.car || null,
       q.text || '', q.ip || null, q.status || 'new', q.slug || null, q.publishedAt || null]);
  }
  return rows.length;
}

async function importKeywords() {
  const map = readJson(path.join(DATA, 'keywords.json'), {});
  const rows = Object.values(map);
  const store = require('../seo/lib/store');
  if (rows.length) await store.keywords.upsert(rows);
  return rows.length;
}

async function importPositions() {
  const rows = readJson(path.join(DATA, 'positions.json'), []);
  let added = 0;
  for (const r of rows) {
    const dup = await db.one(
      'SELECT 1 FROM positions WHERE checked_on=$1 AND engine=$2 AND phrase=$3',
      [r.date, r.engine || 'yandex', r.phrase]);
    if (dup) continue;
    await db.q(`INSERT INTO positions (checked_on, engine, phrase, region, pos, url, top)
                VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [r.date, r.engine || 'yandex', r.phrase, r.region || null, r.pos ?? null, r.url || null,
       JSON.stringify(r.top || [])]);
    added++;
  }
  return added;
}

async function main() {
  console.log(`материалов из content/kb: ${await importMaterials()}`);
  console.log(`вопросов из questions.json: ${await importQuestions()}`);
  console.log(`фраз из keywords.json: ${await importKeywords()}`);
  console.log(`снимков позиций: ${await importPositions()}`);
}

if (require.main === module) {
  main().then(() => db.close()).catch((e) => { console.error('импорт упал:', e.message); process.exit(1); });
}
module.exports = { main };
