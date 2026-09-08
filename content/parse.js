// Разбор материала базы знаний: шапка «--- ключ: значение ---» плюс markdown-тело.
// Один и тот же разбор нужен сборщику, импорту в базу и панели, поэтому он
// вынесен отдельно от content/build.js.
const fs = require('fs');
const path = require('path');

const RUBRICS = ['linzy', 'remont', 'polirovka', 'zakon', 'vybor'];

function parseSource(src, where = 'материал') {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error(`${where}: нет шапки --- ... ---`);
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else v = v.replace(/^["']|["']$/g, '');
    meta[kv[1]] = v;
  }
  if (!meta.slug) throw new Error(`${where}: нет slug`);
  if (!meta.title) throw new Error(`${where}: нет title`);
  if (!RUBRICS.includes(meta.rubric)) throw new Error(`${where}: неизвестная рубрика "${meta.rubric}"`);
  meta.type = meta.type || 'question';
  meta.tags = Array.isArray(meta.tags) ? meta.tags : (meta.tags ? [meta.tags] : []);
  meta.queries = Array.isArray(meta.queries) ? meta.queries : (meta.queries ? [meta.queries] : []);
  return { meta, body: m[2].trim() };
}

function parseFile(file) {
  const doc = parseSource(fs.readFileSync(file, 'utf8'), path.basename(file));
  doc.meta.file = path.basename(file);
  return doc;
}

module.exports = { parseSource, parseFile, RUBRICS };
