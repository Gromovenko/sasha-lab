// Запись собранного. Правда — в postgres (sashalab-pg на RU).
//
// На EU базы нет намеренно (152-ФЗ: персональные данные только на RU), а сбор
// хочется отлаживать и там. Поэтому при отсутствии SASHALAB_PG_URL модуль не
// падает, а пишет NDJSON в .harvest-out/ и честно об этом говорит: файлы — это
// отладка, а не хранилище, залить их в базу можно потом (`node harvest/run.js load`).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../seo/lib/db');
const OUT = process.env.HARVEST_OUT || path.join(__dirname, '..', '.harvest-out');

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const file = (name) => {
  fs.mkdirSync(OUT, { recursive: true });
  return path.join(OUT, `${name}.ndjson`);
};
const append = (name, obj) => fs.appendFileSync(file(name), JSON.stringify(obj) + '\n');

// ── источники ──────────────────────────────────────────────────────────────
async function ensureSource(src) {
  if (!db.enabled) return { id: null, ...src };
  const row = await db.one(`
    INSERT INTO sources (host, kind, title, delay_ms, max_pages, robots_note, note)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (host) DO UPDATE SET kind = EXCLUDED.kind, title = EXCLUDED.title,
      delay_ms = EXCLUDED.delay_ms, max_pages = EXCLUDED.max_pages
    RETURNING *`,
    [src.host, src.kind, src.title || src.host, src.delayMs || 3000, src.maxPages || 300,
      src.robotsNote || null, src.note || null]);
  return row;
}

async function touchSource(id) {
  if (db.enabled && id) await db.q('UPDATE sources SET last_run_at = now() WHERE id = $1', [id]);
}

// ── документы ──────────────────────────────────────────────────────────────
// Идемпотентно по url: тот же текст не переразбираем (parsed_at не сбрасываем),
// изменившийся — сбрасываем, чтобы факты пересобрались.
async function saveDocument(doc) {
  const rec = { ...doc, text_hash: sha1(doc.text || ''), words: (doc.text || '').split(/\s+/).length };
  if (!db.enabled) { append('documents', rec); return { id: null, ...rec, isNew: true }; }
  const row = await db.one(`
    INSERT INTO documents (source_id, url, http_status, title, author, published_at, text,
                           text_hash, words, meta, skip_reason)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (url) DO UPDATE SET
      http_status = EXCLUDED.http_status, title = EXCLUDED.title, text = EXCLUDED.text,
      text_hash = EXCLUDED.text_hash, words = EXCLUDED.words, meta = EXCLUDED.meta,
      published_at = COALESCE(EXCLUDED.published_at, documents.published_at),
      skip_reason = EXCLUDED.skip_reason, fetched_at = now(),
      parsed_at = CASE WHEN documents.text_hash IS DISTINCT FROM EXCLUDED.text_hash
                       THEN NULL ELSE documents.parsed_at END
    RETURNING id, (xmax = 0) AS is_new, parsed_at`,
    [rec.source_id || null, rec.url, rec.http_status || null, rec.title || null, rec.author || null,
      rec.published_at || null, rec.text || null, rec.text_hash, rec.words,
      JSON.stringify(rec.meta || {}), rec.skip_reason || null]);
  return { id: row.id, isNew: row.is_new, parsed_at: row.parsed_at };
}

const knownUrls = async (sourceId) => (!db.enabled || !sourceId) ? new Set()
  : new Set((await db.q('SELECT url FROM documents WHERE source_id = $1', [sourceId])).map((r) => r.url));

const unparsed = async (limit = 500) => !db.enabled ? []
  : db.q(`SELECT id, url, title, text, source_id FROM documents
          WHERE parsed_at IS NULL AND text IS NOT NULL AND skip_reason IS NULL
          ORDER BY id LIMIT $1`, [limit]);

const markParsed = async (ids) => {
  if (db.enabled && ids.length) await db.q('UPDATE documents SET parsed_at = now() WHERE id = ANY($1)', [ids]);
};

// ── факты ──────────────────────────────────────────────────────────────────
async function upsertVehicle(v) {
  if (!db.enabled) { append('vehicles', v); return null; }
  const row = await db.one(`
    INSERT INTO vehicles (make, model, generation, year_from, year_to, slug, mentions)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (slug) DO UPDATE SET
      mentions = vehicles.mentions + EXCLUDED.mentions,
      year_from = LEAST(COALESCE(vehicles.year_from, EXCLUDED.year_from), COALESCE(EXCLUDED.year_from, vehicles.year_from)),
      year_to  = GREATEST(COALESCE(vehicles.year_to, EXCLUDED.year_to), COALESCE(EXCLUDED.year_to, vehicles.year_to)),
      updated_at = now()
    RETURNING id`,
    [v.make, v.model, v.generation || null, v.yearFrom || null, v.yearTo || null, v.slug, v.hits || 1]);
  return row.id;
}

async function upsertPart(p) {
  if (!db.enabled) { append('parts', p); return null; }
  const row = await db.one(`
    INSERT INTO parts (source_id, url, kind, vendor, name, price_rub, specs, available)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (url) DO UPDATE SET
      kind = EXCLUDED.kind, vendor = COALESCE(EXCLUDED.vendor, parts.vendor),
      name = EXCLUDED.name, price_rub = COALESCE(EXCLUDED.price_rub, parts.price_rub),
      specs = parts.specs || EXCLUDED.specs, available = EXCLUDED.available, last_seen = now()
    RETURNING id`,
    [p.source_id || null, p.url, p.kind || 'other', p.vendor || null, p.name,
      p.price_rub || null, JSON.stringify(p.specs || {}), p.available ?? null]);
  return row.id;
}

async function upsertFitment(f) {
  if (!db.enabled) { append('fitment', f); return null; }
  const row = await db.one(`
    INSERT INTO fitment (vehicle_id, headlight, lens, approach, needs_opening, difficulty,
                         hours, notes, confidence, evidence)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (vehicle_id, lens, approach) DO UPDATE SET
      headlight = COALESCE(EXCLUDED.headlight, fitment.headlight),
      needs_opening = COALESCE(EXCLUDED.needs_opening, fitment.needs_opening),
      difficulty = COALESCE(EXCLUDED.difficulty, fitment.difficulty),
      notes = COALESCE(EXCLUDED.notes, fitment.notes),
      -- уверенность растёт от повторов в независимых источниках, но не выше 0.95:
      -- подтверждение мастером — отдельное действие (status='confirmed')
      confidence = LEAST(0.95, GREATEST(fitment.confidence, EXCLUDED.confidence) + 0.05),
      evidence = (SELECT array_agg(DISTINCT e) FROM unnest(fitment.evidence || EXCLUDED.evidence) e),
      updated_at = now()
    RETURNING id`,
    [f.vehicle_id, f.headlight || null, f.lens || '', f.approach || '',
      f.needs_opening ?? null, f.difficulty || null, f.hours || null, f.notes || null,
      f.confidence ?? 0.5, f.evidence || []]);
  return row.id;
}

async function stats() {
  if (!db.enabled) return { db: false, out: OUT };
  const [s] = await db.q(`
    SELECT (SELECT count(*) FROM sources)   AS sources,
           (SELECT count(*) FROM documents) AS documents,
           (SELECT count(*) FROM documents WHERE parsed_at IS NULL) AS unparsed,
           (SELECT count(*) FROM vehicles)  AS vehicles,
           (SELECT count(*) FROM parts)     AS parts,
           (SELECT count(*) FROM fitment)   AS fitment`);
  return { db: true, ...s };
}

module.exports = { ensureSource, touchSource, saveDocument, knownUrls, unparsed, markParsed,
  upsertVehicle, upsertPart, upsertFitment, stats, OUT, sha1 };
