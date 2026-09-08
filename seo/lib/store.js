// Хранилище SEO-данных: плоские JSON-файлы в seo/data (репозиторий без зависимостей,
// объёмы маленькие — сотни фраз и снимков позиций, БД тут была бы лишней сущностью).
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data');

function file(name) { return path.join(DIR, `${name}.json`); }

function read(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); }
  catch { return fallback; }
}

function write(name, value) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file(name), JSON.stringify(value, null, 2) + '\n');
  return value;
}

// Ключевые фразы: { phrase → { phrase, count, source, cluster, checkedAt } }
const keywords = {
  all: () => read('keywords', {}),
  save: (map) => write('keywords', map),
  upsert(rows, source) {
    const map = keywords.all();
    for (const r of rows) {
      const k = r.phrase.toLowerCase();
      map[k] = { ...(map[k] || {}), ...r, phrase: r.phrase, source: source || (map[k] && map[k].source) || 'manual' };
    }
    return keywords.save(map);
  },
};

// Снимки позиций: массив { date, engine, phrase, pos, url, top:[{pos,domain,url}] }
const positions = {
  all: () => read('positions', []),
  save: (rows) => write('positions', rows),
  add(rows) {
    const cur = positions.all();
    return positions.save(cur.concat(rows));
  },
  // последний снимок по каждой паре (движок, фраза)
  latest() {
    const by = new Map();
    for (const r of positions.all()) {
      const k = `${r.engine}|${r.phrase.toLowerCase()}`;
      const prev = by.get(k);
      if (!prev || prev.date < r.date) by.set(k, r);
    }
    return [...by.values()];
  },
};

module.exports = { read, write, keywords, positions, DIR };
