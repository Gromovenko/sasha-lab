// База авто со ссылками на все ресурсы (таблица vehicle_links).
//
// Связь машина → страница строится тремя способами, от точного к грубому:
//   evidence — из страницы вынут факт посадки для этой машины (fitment.evidence);
//   url      — «марка-модель» стоит в самом адресе (electro-kot.ru/haval/jolion/…);
//   title    — то же в заголовке страницы латиницей.
// Текст страниц не сканируем: 38 тыс. документов × 1400 машин — часы, а адрес и
// заголовок дают ту же связь без ложных срабатываний вроде «mazda 3» в тексте
// про что-то другое. Марка обязательна в шаблоне, поэтому «3» или «x5» не липнут.
const db = require('../seo/lib/db');
const http = require('./http');

// Адрес/заголовок приводим к «слово-слово»: разделители → '-', регистр вниз.
const NORM = (col) => `regexp_replace(lower(${col}), '[^a-z0-9]+', '-', 'g')`;

async function rebuild() {
  if (!db.enabled) throw new Error('нужна база (SASHALAB_PG_URL)');
  return db.tx(async (c) => {
    await c.query('DELETE FROM vehicle_links');
    // 1. evidence — самая надёжная связь
    await c.query(`
      INSERT INTO vehicle_links (vehicle_id, document_id, source_id, url, title, basis, http_status)
      SELECT DISTINCT ON (f.vehicle_id, d.id) f.vehicle_id, d.id, d.source_id, d.url, d.title, 'evidence', d.http_status
      FROM fitment f, unnest(f.evidence) e JOIN documents d ON d.id = e`);
    // 2. и 3. адрес, затем заголовок. Слаг вида haval-jolion; границы — не [a-z0-9].
    for (const [basis, col] of [['url', 'd.url'], ['title', 'd.title']]) {
      await c.query(`
        INSERT INTO vehicle_links (vehicle_id, document_id, source_id, url, title, basis, http_status)
        SELECT v.id, d.id, d.source_id, d.url, d.title, '${basis}', d.http_status
        FROM vehicles v
        JOIN documents d ON ${col} IS NOT NULL
          AND (d.http_status IS NULL OR d.http_status = 200)
          AND ('-' || ${NORM(col)} || '-') LIKE '%-' || v.slug || '-%'
        ON CONFLICT DO NOTHING`);
    }
    const [r] = (await c.query(`
      SELECT (SELECT count(*) FROM vehicle_links) AS links,
             (SELECT count(DISTINCT vehicle_id) FROM vehicle_links) AS cars,
             (SELECT count(*) FROM vehicles) AS vehicles`)).rows;
    return r;
  });
}

// Живые ли ссылки: HEAD (при отказе — GET) к каждому адресу с паузой хоста.
// Медленно НАМЕРЕННО — тот же принцип, что у сбора. limit — сколько самых
// давно не проверявшихся адресов взять за заход.
async function check({ limit = 200 } = {}) {
  if (!db.enabled) throw new Error('нужна база (SASHALAB_PG_URL)');
  const rows = await db.q(`
    SELECT DISTINCT ON (l.url) l.url, s.host, s.delay_ms FROM vehicle_links l
    LEFT JOIN sources s ON s.id = l.source_id
    ORDER BY l.url, l.checked_at NULLS FIRST LIMIT $1`, [limit]);
  let ok = 0, dead = 0;
  for (const r of rows) {
    let status = null;
    // http.get сам держит паузу хоста и уважает robots (skipped → статус 0)
    try { status = (await http.get(r.url, { delayMs: r.delay_ms || 3000, useCache: false })).status; } catch { status = 0; }
    await db.q('UPDATE vehicle_links SET http_status = $2, checked_at = now() WHERE url = $1', [r.url, status]);
    status === 200 ? ok++ : dead++;
  }
  return { checked: rows.length, ok, dead };
}

// CSV «машина → все ресурсы» для человека: одна строка на машину, ссылки через пробел.
async function exportRows() {
  return db.q(`
    SELECT r.make, r.model, r.generation, r.year_from, r.year_to, r.slug, r.facts, r.links, r.sources,
           coalesce((SELECT string_agg(l.url, E'\\n' ORDER BY l.basis, l.url)
                     FROM vehicle_links l WHERE l.vehicle_id = r.vehicle_id
                       AND (l.http_status IS NULL OR l.http_status = 200)), '') AS urls
    FROM vehicle_resources r ORDER BY r.links DESC, r.make, r.model`);
}
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const toCsv = (rows) => ['make;model;generation;years;facts;links;sources;urls',
  ...rows.map((r) => [r.make, r.model, r.generation, [r.year_from, r.year_to].filter(Boolean).join('–'),
    r.facts, r.links, r.sources, r.urls].map(csvCell).join(';'))].join('\n');

module.exports = { rebuild, check, exportRows, toCsv, NORM };
