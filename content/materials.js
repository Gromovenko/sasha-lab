// Материалы базы знаний. Источник правды — таблица materials в postgres;
// content/kb/*.md остаётся входом для ручного наполнения (db/import.js).
//
// Почему так: материал, опубликованный владельцем из панели на проде, раньше был
// файлом в дереве кода — и следующий rsync --delete с EU его сносил. База такого
// не допускает. Без настроенной базы (dev-копия на EU) читаем файлы, чтобы
// сборка и просмотр работали без хранилища.
const fs = require('fs');
const path = require('path');
const db = require('../seo/lib/db');
const { parseFile } = require('./parse');

const KB = path.join(__dirname, 'kb');

const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);

function fromFiles() {
  const files = fs.existsSync(KB) ? fs.readdirSync(KB).filter((f) => f.endsWith('.md')).sort() : [];
  return files.map((f) => parseFile(path.join(KB, f)));
}

async function fromDb() {
  const rows = await db.q(
    `SELECT * FROM materials WHERE published ORDER BY rubric, slug`);
  return rows.map((r) => ({
    meta: {
      slug: r.slug, rubric: r.rubric, type: r.type, title: r.title,
      description: r.description || '', tags: r.tags || [], queries: r.queries || [],
      asker: r.asker || '', question: r.question || '', updated: r.updated_label || '',
    },
    body: r.body,
  }));
}

// Источник выбирается наличием базы, а не флагом: на проде база есть всегда.
async function load() {
  return db.enabled ? fromDb() : fromFiles();
}

async function get(slug) {
  return db.one('SELECT * FROM materials WHERE slug = $1', [slug]);
}

async function upsert(meta, body, { questionId = null } = {}) {
  await db.q(
    `INSERT INTO materials (slug, rubric, type, title, description, body, tags, queries,
                            asker, question, updated_label, question_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (slug) DO UPDATE SET
       rubric=EXCLUDED.rubric, type=EXCLUDED.type, title=EXCLUDED.title,
       description=EXCLUDED.description, body=EXCLUDED.body, tags=EXCLUDED.tags,
       queries=EXCLUDED.queries, asker=EXCLUDED.asker, question=EXCLUDED.question,
       updated_label=EXCLUDED.updated_label,
       question_id=COALESCE(EXCLUDED.question_id, materials.question_id),
       updated_at=now()`,
    [meta.slug, meta.rubric, meta.type || 'question', meta.title, meta.description || null,
     body, arr(meta.tags), arr(meta.queries), meta.asker || null, meta.question || null,
     meta.updated || null, questionId]);
  return meta.slug;
}

async function remove(slug) {
  await db.q('DELETE FROM materials WHERE slug = $1', [slug]);
}

async function taken(slug) {
  if (db.enabled) return Boolean(await db.one('SELECT 1 FROM materials WHERE slug=$1', [slug]));
  return fs.existsSync(path.join(KB, `${slug}.md`));
}

module.exports = { load, fromFiles, fromDb, get, upsert, remove, taken, KB };
