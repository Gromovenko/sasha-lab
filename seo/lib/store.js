// Хранилище SEO-данных: postgres (см. db/migrations/001_init.sql).
//
// Раньше здесь лежали плоские JSON-файлы. Их сняли не ради красоты: материалы,
// опубликованные из панели на проде, сносил rsync --delete с EU, а вопросы живых
// людей с телефонами лежали файлом в дереве кода. Всё, что копится и переживает
// выкат, теперь в базе; файлы остались только входом для ручного наполнения.
//
// API асинхронный — вызывающие (панель, cli, jobs) это ждут.
const db = require('./db');

const num = (v) => (v == null || v === '' ? null : Number(v));

// Ключевые фразы: { фраза → { phrase, count, shows, impressions, clicks,
//                             yandexPos, googlePos, source, seed, checkedAt } }
const keywords = {
  async rows() {
    const rs = await db.q('SELECT * FROM keywords ORDER BY count DESC NULLS LAST');
    return rs.map((r) => ({
      phrase: r.display || r.phrase,
      count: r.count, shows: r.shows, impressions: r.impressions, clicks: r.clicks,
      yandexPos: r.yandex_pos == null ? null : Number(r.yandex_pos),
      googlePos: r.google_pos == null ? null : Number(r.google_pos),
      source: r.source, seed: r.seed, cluster: r.cluster,
      checkedAt: r.checked_at ? r.checked_at.toISOString().slice(0, 10) : null,
    }));
  },
  // Совместимость с прежним видом «объект по фразе» — панель и cli так её читают.
  async all() {
    return Object.fromEntries((await keywords.rows()).map((k) => [k.phrase.toLowerCase(), k]));
  },
  // Источники дописывают СВОИ поля и не затирают чужие: Wordstat приносит
  // частотность, Вебмастер — показы, GSC — свои. COALESCE тут по этой причине.
  async upsert(rows, source) {
    if (!rows.length) return 0;
    await db.tx(async (c) => {
      for (const r of rows) {
        await c.query(
          `INSERT INTO keywords (phrase, display, count, shows, impressions, clicks,
                                 yandex_pos, google_pos, source, seed, checked_at, updated_at)
           VALUES (lower($1),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
           ON CONFLICT (phrase) DO UPDATE SET
             display     = EXCLUDED.display,
             count       = COALESCE(EXCLUDED.count, keywords.count),
             shows       = COALESCE(EXCLUDED.shows, keywords.shows),
             impressions = COALESCE(EXCLUDED.impressions, keywords.impressions),
             clicks      = COALESCE(EXCLUDED.clicks, keywords.clicks),
             yandex_pos  = COALESCE(EXCLUDED.yandex_pos, keywords.yandex_pos),
             google_pos  = COALESCE(EXCLUDED.google_pos, keywords.google_pos),
             source      = COALESCE(EXCLUDED.source, keywords.source),
             seed        = COALESCE(EXCLUDED.seed, keywords.seed),
             checked_at  = COALESCE(EXCLUDED.checked_at, keywords.checked_at),
             updated_at  = now()`,
          [r.phrase, num(r.count), num(r.shows), num(r.impressions), num(r.clicks),
           num(r.yandexPos), num(r.googlePos), source || r.source || 'manual',
           r.seed || null, r.checkedAt || null]);
      }
    });
    return rows.length;
  },
  async count() { return Number((await db.one('SELECT count(*)::int AS n FROM keywords')).n); },
};

// Снимки позиций: историю не перетираем, смысл ряда — в изменении.
const positions = {
  async add(rows) {
    if (!rows.length) return 0;
    await db.tx(async (c) => {
      for (const r of rows) {
        await c.query(
          `INSERT INTO positions (checked_on, engine, phrase, region, pos, url, top)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [r.date, r.engine || 'yandex', r.phrase, r.region || null,
           r.pos == null ? null : Number(r.pos), r.url || null, JSON.stringify(r.top || [])]);
      }
    });
    return rows.length;
  },
  // Последний снимок по каждой паре (движок, фраза).
  async latest() {
    const rs = await db.q(
      `SELECT DISTINCT ON (engine, phrase) engine, phrase, pos, url, region, top, checked_on
         FROM positions ORDER BY engine, phrase, checked_on DESC, id DESC`);
    return rs.map((r) => ({
      engine: r.engine, phrase: r.phrase, pos: r.pos, url: r.url, region: r.region,
      top: r.top || [], date: r.checked_on.toISOString().slice(0, 10),
    }));
  },
  async history(phrase, { engine = 'yandex', limit = 90 } = {}) {
    return db.q(`SELECT checked_on, pos, url FROM positions
                  WHERE engine=$1 AND phrase=$2 ORDER BY checked_on DESC LIMIT $3`,
      [engine, phrase, limit]);
  },
};

// Мелкое состояние панели: выгрузки, последняя ошибка задачи.
const kv = {
  async get(key, fallback = null) {
    const r = await db.one('SELECT value FROM kv WHERE key=$1', [key]);
    return r ? r.value : fallback;
  },
  async set(key, value) {
    await db.q(`INSERT INTO kv (key, value, updated_at) VALUES ($1,$2,now())
                ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [key, JSON.stringify(value)]);
    return value;
  },
};

// Журнал запусков сбора: панель должна показывать, что именно не получилось,
// а не молчаливые нули.
const runs = {
  async start(job) {
    const r = await db.one('INSERT INTO job_runs (job) VALUES ($1) RETURNING id', [job]);
    return r.id;
  },
  async finish(id, { ok, error, stats }) {
    if (!id) return;
    await db.q(`UPDATE job_runs SET finished_at=now(), ok=$2, error=$3, stats=$4 WHERE id=$1`,
      [id, Boolean(ok), error || null, JSON.stringify(stats || {})]);
  },
  async last(limit = 8) {
    return db.q('SELECT job, started_at, finished_at, ok, error, stats FROM job_runs ORDER BY id DESC LIMIT $1', [limit]);
  },
};

module.exports = { keywords, positions, kv, runs, db };
