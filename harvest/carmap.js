// Мост «старая запись справочника vehicles → машина из базы авто cars».
// Слои fitment / vehicle_parts / vehicle_links привязаны к грязному справочнику;
// мост даёт им car_id, не удаляя и не меняя старые записи.
//
// exact — марка и нормализованная модель совпали, годы пересеклись (или у записи
//         годов нет, а машина по модели одна).
// fuzzy — совпало базовое имя модели («CX-5 II» → cx5), либо годы пересеклись
//         только с допуском ±1 год.
// Неоднозначные (два равных кандидата), слишком широкие («Camry 1981–2025») и без
// пары — в seo/data/vehicle-map-unmatched.csv: они остаются «на модель в целом».
const fs = require('fs');
const path = require('path');
const db = require('../seo/lib/db');
const { slugify } = require('./vehicles');

const flat = (s) => slugify(String(s || '')).replace(/[^a-z0-9]/g, '');
// «CX-5 II», «Seltos SP2», «Camry 3» → база модели без номера поколения
const baseOf = (m) => String(m || '').toLowerCase()
  .replace(/[\s-]+(?:[ivx]{1,4}|\d{1,2}|sp\d+|gen\d*|mk\d+)$/i, '').trim();

// Число общих лет (с допуском tol на каждом краю) или null, если не пересеклись / годов нет.
const ov = (a, b, tol = 0) => {
  if (a.year_from == null || b.year_from == null) return null;
  const n = Math.min(a.year_to ?? 2100, b.year_to ?? 2100) + tol - (Math.max(a.year_from, b.year_from) - tol) + 1;
  return n > 0 ? n : null;
};

// → { car_id, method } | { unmatched: 'ambiguous'|'no_car'|'no_model' }
function mapVehicle(v, carsByMake) {
  const list = carsByMake.get(flat(v.make));
  if (!list) return { unmatched: 'no_car' };
  const full = flat(v.model), base = flat(baseOf(v.model));
  let same = list.filter((c) => flat(c.model) === full);
  let byName = 'exact';
  if (!same.length) { same = list.filter((c) => flat(c.model) === base || flat(baseOf(c.model)) === base); byName = 'fuzzy'; }
  if (!same.length) return { unmatched: 'no_model' };
  if (v.year_from == null) {
    return same.length === 1 ? { car_id: same[0].id, method: byName } : { unmatched: 'ambiguous', cands: same.map((c) => c.id) };
  }
  const strict = same.map((c) => [c, ov(v, c, 0)]).filter(([, s]) => s);
  const loose = strict.length ? strict : same.map((c) => [c, ov(v, c, 1)]).filter(([, s]) => s);
  if (!loose.length) return { unmatched: 'no_car' };
  loose.sort((a, b) => b[1] - a[1]);
  if (loose.length > 1 && loose[0][1] === loose[1][1]) return { unmatched: 'ambiguous', cands: loose.map(([c]) => c.id) };
  // Запись справочника вида «Camry 1981–2025» — это «модель в целом», а не поколение:
  // приколоть её к одному поколению нельзя, иначе её детали пропадут из всех
  // остальных годов. Такие записи оставляем без car_id (решает разбор названия).
  const span = (x) => (x.year_from == null ? null : (x.year_to ?? 2100) - x.year_from + 1);
  const vs = span(v), cs = span(loose[0][0]);
  if (vs && cs && vs > 12 && vs > cs * 2) return { unmatched: 'too_wide', cands: loose.map(([c]) => c.id) };
  const method = strict.length && byName === 'exact' ? 'exact' : 'fuzzy';
  return { car_id: loose[0][0].id, method };
}

function indexCars(cars) {
  const m = new Map();
  for (const c of cars) {
    const k = flat(c.make);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(c);
  }
  return m;
}

const csv = (rows) => '﻿' + ['vehicle_id;slug;make;model;year_from;year_to;reason;candidates']
  .concat(rows.map((r) => [r.id, r.slug, r.make, r.model, r.year_from, r.year_to, r.reason, (r.cands || []).join(' ')]
    .map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(';'))).join('\n');

async function rebuild({ out = path.join(__dirname, '../seo/data/vehicle-map-unmatched.csv') } = {}) {
  const cars = await db.q(`SELECT id, make, model, year_from, year_to FROM cars WHERE status <> 'no_year'`);
  const vehicles = await db.q('SELECT id, slug, make, model, year_from, year_to FROM vehicles');
  const idx = indexCars(cars);
  const ok = [], bad = [];
  for (const v of vehicles) {
    const r = mapVehicle(v, idx);
    if (r.car_id) ok.push([v.id, r.car_id, r.method]); else bad.push({ ...v, reason: r.unmatched, cands: r.cands });
  }
  await db.q('TRUNCATE vehicle_car_map');
  for (let i = 0; i < ok.length; i += 500) {
    const ch = ok.slice(i, i + 500);
    await db.q(`INSERT INTO vehicle_car_map (vehicle_id, car_id, method) VALUES ${ch.map((_, j) => `($${j * 3 + 1},$${j * 3 + 2},$${j * 3 + 3})`).join(',')}`, ch.flat());
  }
  const upd = {};
  for (const t of ['fitment', 'vehicle_parts', 'vehicle_links']) {
    // Сначала гасим прежние значения: запись, потерявшая пару (стала too_wide или
    // неоднозначной), иначе осталась бы с устаревшим car_id.
    await db.q(`UPDATE ${t} SET car_id = NULL WHERE car_id IS NOT NULL`);
    await db.q(`UPDATE ${t} x SET car_id = m.car_id FROM vehicle_car_map m WHERE m.vehicle_id = x.vehicle_id`);
    const r = await db.one(`SELECT count(*)::int total, count(car_id)::int mapped FROM ${t}`);
    upd[t] = r;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, csv(bad));
  return { vehicles: vehicles.length, mapped: ok.length, exact: ok.filter((x) => x[2] === 'exact').length,
    fuzzy: ok.filter((x) => x[2] === 'fuzzy').length, unmatched: bad.length, layers: upd, csv: out };
}

module.exports = { mapVehicle, indexCars, rebuild, flat, baseOf };
