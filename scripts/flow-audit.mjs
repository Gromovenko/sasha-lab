#!/usr/bin/env node
// Юзер-прогон sasha-lab: анонимный обход публичных страниц и ручек глазами посетителя.
//   node scripts/flow-audit.mjs --base http://127.0.0.1:3060      (тест EU, в порт мимо basic-auth)
//   node scripts/flow-audit.mjs --base https://sashalab.77-105-168-153.sslip.io   (прод)
// --ui принимается для совместимости с даш-контрактом (браузерного шага у сайта нет).
// Ничего не создаёт и не пишет — законен и на проде. Выход: 0 — FAIL нет, 1 — есть.
// Формат строк — как у lifeprotocol/letov: «✓ », «✗ », «! » (по ним даш считает итог).
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('--base', 'http://127.0.0.1:3060').replace(/\/$/, '');
const OUT = arg('--out', `/tmp/sashalab-flow-audit-${Date.now()}`);
fs.mkdirSync(OUT, { recursive: true });
const findings = [];
const log = (level, name, msg) => {
  findings.push({ level, name, msg });
  console.log(`${level === 'OK' ? '✓' : level === 'FAIL' ? '✗' : '!'} ${name}: ${msg}`);
};
const get = async (p) => {
  const t = Date.now();
  const r = await fetch(BASE + p, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
  return { r, body: await r.text(), ms: Date.now() - t };
};

const PAGES = ['/', '/baza/', '/baza/pomoshnik/', '/sitemap.xml', '/robots.txt'];
const API = [['/baza/podbor?make=toyota&model=camry&year=2015', j => j && typeof j === 'object']];

(async () => {
  console.log(`Прогон sasha-lab: ${BASE}  (${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК)\n`);
  const assets = new Set();
  for (const p of PAGES) {
    try {
      const { r, body, ms } = await get(p);
      if (r.status !== 200) { log('FAIL', `страница ${p}`, `HTTP ${r.status}`); continue; }
      if (!body.length) { log('FAIL', `страница ${p}`, 'пустой ответ'); continue; }
      log(ms > 5000 ? 'WARN' : 'OK', `страница ${p}`, `200, ${body.length} б, ${ms} мс`);
      if (/html/.test(r.headers.get('content-type') || ''))
        for (const m of body.matchAll(/(?:href|src)="(\/(?:cdn|baza|stub)\/[^"#?]+)/g)) assets.add(m[1]);
    } catch (e) { log('FAIL', `страница ${p}`, String(e.message || e)); }
  }
  // локальные ассеты со страниц: битая ссылка = сломанная вёрстка у посетителя
  let bad = 0;
  for (const a of [...assets].slice(0, 60)) {
    try { const r = await fetch(BASE + a, { signal: AbortSignal.timeout(20000) }); if (r.status >= 400) { bad++; log('FAIL', `ассет ${a}`, `HTTP ${r.status}`); } }
    catch (e) { bad++; log('FAIL', `ассет ${a}`, String(e.message || e)); }
  }
  if (!bad) log('OK', 'ассеты', `${Math.min(assets.size, 60)} ссылок со страниц — все отвечают`);
  for (const [p, ok] of API) {
    try {
      const { r, body } = await get(p);
      let j = null; try { j = JSON.parse(body); } catch {}
      if (r.status !== 200 || !ok(j)) log('FAIL', `ручка ${p}`, `HTTP ${r.status}, ответ не JSON нужной формы`);
      else log('OK', `ручка ${p}`, '200, JSON');
    } catch (e) { log('FAIL', `ручка ${p}`, String(e.message || e)); }
  }
  const fails = findings.filter(f => f.level === 'FAIL').length, warns = findings.filter(f => f.level === 'WARN').length;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ base: BASE, at: new Date().toISOString(), findings }, null, 2));
  console.log(`\nИТОГ: ${fails} FAIL, ${warns} WARN — отчёт и кадры: ${OUT}`);
  process.exit(fails ? 1 : 0);
})();
