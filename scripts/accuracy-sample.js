#!/usr/bin/env node
// Выборка фактов для проверки мастером: node scripts/accuracy-sample.js [N] [минимум уверенности]
// Пишет seo/data/accuracy-sample.csv: одна строка — один факт, с ссылкой на страницу-источник
// и пустыми столбцами «верно (да/нет)» и «комментарий». Доля «да» и есть измеренная точность.
// Берём случайные факты с уверенностью от порога, не больше двух с одной машины и одного сайта.
const fs = require('fs');
const path = require('path');
require('../server-env')(path.join(__dirname, '..', 'seo', '.env'));
const db = require('../seo/lib/db');

const N = Number(process.argv[2]) || 40;
const MIN = Number(process.argv[3]) || 0.7;
const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

(async () => {
  const rows = await db.q(`
    SELECT f.id, v.make, v.model, v.year_from, v.year_to, f.lens, f.headlight, f.approach,
           f.needs_opening, f.sealant, f.low_beam_source, f.confidence,
           d.url, s.host
      FROM fitment f
      JOIN vehicles v ON v.id = f.vehicle_id
      JOIN LATERAL (SELECT d.* FROM documents d WHERE d.id = f.evidence[1]) d ON true
      JOIN sources s ON s.id = d.source_id
     WHERE f.status = 'draft' AND f.confidence >= $1 AND f.lens <> ''
     ORDER BY random() LIMIT $2`, [MIN, N * 6]);
  const perV = new Map(); const perH = new Map(); const pick = [];
  for (const r of rows) {
    const a = perV.get(`${r.make}${r.model}`) || 0; const b = perH.get(r.host) || 0;
    if (a >= 2 || b >= Math.ceil(N / 8)) continue;
    perV.set(`${r.make}${r.model}`, a + 1); perH.set(r.host, b + 1);
    pick.push(r);
    if (pick.length >= N) break;
  }
  const head = ['id', 'машина', 'годы', 'линза', 'фара', 'вскрытие', 'герметик', 'штатный свет',
    'уверенность', 'источник', 'верно (да/нет)', 'комментарий'];
  const lines = [head.map(esc).join(',')];
  for (const r of pick) {
    lines.push([r.id, `${r.make} ${r.model}`, `${r.year_from || ''}-${r.year_to || ''}`, r.lens,
      r.headlight, r.approach, r.sealant, r.low_beam_source, r.confidence, r.url, '', ''].map(esc).join(','));
  }
  const out = path.join(__dirname, '..', 'seo', 'data', 'accuracy-sample.csv');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `﻿${lines.join('\n')}\n`);
  console.log(`${pick.length} фактов → ${out}`);
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
