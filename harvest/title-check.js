// Проверка разбора заголовков выборкой для мастера: 60 случайных заголовков разных
// сайтов и видов деталей с тем, как их прочитал код, и столбцами «верно да/нет»,
// «комментарий». AFS в файл не входит (решение владельца 26.09.2026).
//   node harvest/run.js title-check                 → выборка в seo/data/title-parse-check.csv
//   node harvest/run.js title-check <файл.csv>      → доля верных по маркам и сайтам
const fs = require('fs');
const path = require('path');
const { parseTitle } = require('./carbase');

const COLS = ['site', 'title', 'make', 'model', 'body', 'years', 'part_kind', 'purpose', 'верно', 'комментарий'];
const esc = (v) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`);

function rowOf(host, title) {
  const o = parseTitle(title, host);
  if (!o) return { site: host, title };
  return { site: host, title, make: o.make, model: o.model, body: o.gen,
    years: o.year_from ? `${o.year_from}-${o.year_to}` : '', part_kind: o.part_kind, purpose: o.purpose };
}

// Равномерно по сайтам и видам детали: раунд-робин по группам «сайт|вид».
function pick(rows, n, rnd = Math.random) {
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.site}|${r.part_kind || ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const lists = [...groups.values()].map((l) => l.sort(() => rnd() - 0.5)).sort(() => rnd() - 0.5);
  const out = [];
  for (let i = 0; out.length < n && lists.some((l) => l.length > i); i++) {
    for (const l of lists) if (l[i] && out.length < n) out.push(l[i]);
  }
  return out;
}

const toCsv = (rows) => '﻿' + [COLS.join(';')].concat(rows.map((r) => COLS.map((c) => esc(r[c])).join(';'))).join('\n');

async function sample({ n = 60, out }) {
  const db = require('../seo/lib/db');
  const docs = await db.q(`SELECT s.host, d.title FROM documents d JOIN sources s ON s.id = d.source_id
    WHERE d.skip_reason IS NULL AND d.title ~* 'рамк|стекл|корпус|набор|комплект|модул|ламп|линз'
    ORDER BY random() LIMIT 4000`);
  const rows = docs.map((d) => rowOf(d.host.replace(/^www\./, ''), d.title)).filter((r) => r.make);
  const list = pick(rows, n);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, toCsv(list));
  return list.length;
}

function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const split = (l) => { const c = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ';') { c.push(cur); cur = ''; } else cur += ch;
    } c.push(cur); return c; };
  const head = split(lines[0]);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v])));
}

// Доля верных: «да» / «нет»; пустые ячейки не считаются проверенными.
function score(text) {
  const rows = parseCsv(text).filter((r) => /^(да|нет)$/i.test(String(r['верно']).trim()));
  const byMake = {}, byHost = {};
  let ok = 0;
  for (const r of rows) {
    const yes = /^да$/i.test(r['верно'].trim());
    if (yes) ok++;
    for (const [m, k] of [[byMake, r.make || '—'], [byHost, r.site || '—']]) {
      m[k] = m[k] || { n: 0, ok: 0 };
      m[k].n++; if (yes) m[k].ok++;
    }
  }
  return { total: rows.length, ok, pct: rows.length ? Number((100 * ok / rows.length).toFixed(1)) : 0, byMake, byHost };
}

module.exports = { rowOf, pick, toCsv, sample, score, parseCsv, COLS };
