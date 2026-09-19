#!/usr/bin/env node
// Командная строка сбора базы знаний.
//
//   node harvest/run.js sources                 — что за источники и что им разрешено
//   node harvest/run.js crawl works [--limit 50]— этап 1: примеры работ
//   node harvest/run.js crawl parts             — этап 2: комплектующие
//   node harvest/run.js crawl community         — этап 3: сообщество (hidplanet)
//   node harvest/run.js crawl <хост>            — один источник
//   node harvest/run.js tg <канал> [--pages 10] — телеграм: публичное превью
//   node harvest/run.js tg-import <result.json> [--channel имя]
//   node harvest/run.js probe [--hosts a,b]     — замер безопасной скорости источников
//   node harvest/run.js facts [--limit 500]     — разбор скачанного в факты
//   node harvest/run.js stats                   — что накоплено
//
// Сбор идёт медленно НАМЕРЕННО (пауза на источник, потолок страниц за заход):
// это не «медленно», это условие, при котором нас не закроют на второй день.
const path = require('path');
require('../server-env')(path.join(__dirname, '..', 'seo', '.env'));

const { SOURCES, byHost, byKind } = require('./sources');
const crawl = require('./crawl');
const probe = require('./probe');
const facts = require('./facts');
const store = require('./store');
const tg = require('./telegram');
const db = require('../seo/lib/db');
const http = require('./http');

const HELP = `
sasha-lab · сбор базы знаний

  sources                    какие источники и что им разрешает robots.txt
  crawl works|parts|community|<хост> [--limit N] [--refetch]
  tg <канал> [--pages 10]    телеграм: публичное превью t.me/s/
  tg-import <result.json> [--channel имя]
  probe [--hosts a,b]        замер безопасной скорости каждого источника + план очереди
  facts [--limit 500]        разбор скачанного в машины/комплектующие/совместимость
  facts --reparse            пересчитать черновые факты с нуля (после правки правил)
  stats                      что накоплено

Окружение: SASHALAB_PG_URL (без неё сбор пишет NDJSON в .harvest-out и говорит об этом).
`;

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

async function main() {
  switch (cmd) {
    case 'sources': {
      for (const s of SOURCES) {
        const r = await http.robots(s.host, s.ua);
        const dis = r.disallow.length ? `запрещено путей: ${r.disallow.length}` : 'запретов нет';
        console.log(`  ${s.kind.padEnd(9)} ${s.host.padEnd(20)} ${s.enabled === false ? 'ВЫКЛЮЧЕН, ' : ''}пауза ${s.delayMs} мс, ${dis}`
          + (s.note ? `\n${' '.repeat(12)}⚠ ${s.note}` : ''));
      }
      break;
    }
    case 'crawl': {
      const what = argv[1];
      const list = ['works', 'parts', 'community'].includes(what) ? byKind(what)
        : what ? [byHost(what)].filter(Boolean) : SOURCES;
      if (!list.length) return console.error(`не знаю источник «${what}», см. sources`);
      const limit = Number(flag('limit', 0)) || undefined;
      for (const s of list) {
        if (s.enabled === false) { console.log(`  ${s.host}: выключен — ${s.note || 'см. sources'}`); continue; }
        const t = Date.now();
        const st = await crawl.crawlSource(s, { limit, refetch: argv.includes('--refetch') });
        console.log(`  ${st.host}: в sitemap ${st.listed}, скачано ${st.fetched}, `
          + `сохранено ${st.saved}, не по теме ${st.offtopic}, robots ${st.robots}, `
          + `ошибок ${st.errors} — ${Math.round((Date.now() - t) / 1000)} с`);
      }
      break;
    }
    case 'tg': {
      const st = await tg.fromWeb(argv[1], { pages: Number(flag('pages', 10)) });
      console.log(`  @${st.channel}: постов ${st.fetched}, сохранено ${st.saved}, коротких ${st.short}`);
      break;
    }
    case 'tg-import': {
      const st = await tg.fromExport(argv[1], { channel: flag('channel') });
      console.log(`  @${st.channel}: сообщений ${st.messages}, сохранено ${st.saved}, коротких ${st.short}`);
      break;
    }
    // Замер скорости: сколько источник реально выдерживает. Результат ложится
    // в seo/data/harvest-speed.json — оттуда же очередь сбора берёт ПОРЯДОК
    // хостов (сначала быстрые и почти готовые, самые долгие в конце), чтобы
    // польза от захода появлялась в первые часы, а не через сутки.
    case 'probe': {
      const hosts = String(flag('hosts', '')).split(',').map((x) => x.trim()).filter(Boolean);
      const res = await probe.run({ hosts });
      const have = db.enabled
        ? await db.q('SELECT s.host, count(d.id)::int AS docs FROM sources s'
          + ' LEFT JOIN documents d ON d.source_id = s.id GROUP BY 1')
        : [];
      const docsOf = Object.fromEntries(have.map((r) => [r.host, r.docs]));
      const plan = res.map((r) => {
        const src = byHost(r.host) || {};
        const cap = src.maxPages || 0;
        // Режим заголовков чужой сервер не листает: одна карта сайта за заход,
        // дальше считаем у себя — время такого источника от паузы не зависит.
        const left = src.mode === 'titles' ? 0 : Math.max(0, cap - (docsOf[r.host] || 0));
        return { ...r, docs: docsOf[r.host] || 0, maxPages: cap, left,
          etaHours: Math.round((left * r.perPageMs) / 3600000 * 10) / 10 };
      }).sort((a, b) => a.etaHours - b.etaHours);
      const file = path.join(__dirname, '..', 'seo', 'data', 'harvest-speed.json');
      const fs = require('fs');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Замер по части хостов (--hosts) ДОПОЛНЯЕТ план, а не затирает его:
      // иначе пере-замер одного источника стёр бы порядок очереди для всех
      // остальных, и `--plan` пошёл бы собирать один хост из восемнадцати.
      let prev = [];
      try { prev = JSON.parse(fs.readFileSync(file, 'utf8')).plan || []; } catch { /* плана ещё нет */ }
      const fresh = new Set(plan.map((x) => x.host));
      const merged = [...plan, ...prev.filter((x) => !fresh.has(x.host))]
        .sort((a, b) => a.etaHours - b.etaHours);
      fs.writeFileSync(file, JSON.stringify({ measuredAt: new Date().toISOString(), plan: merged }, null, 2));
      console.log('\n  порядок очереди (по времени захода, самые долгие в конце):');
      for (const p of plan) {
        console.log(`    ${p.host.padEnd(20)} пауза ${String(p.recommend).padStart(5)} мс, `
          + `в базе ${String(p.docs).padStart(5)} из ${String(p.maxPages).padStart(5)}, `
          + `осталось ${String(p.left).padStart(5)} → ${p.etaHours} ч`);
      }
      console.log(`\n  итого заход: ${Math.round(plan.reduce((a, b) => a + b.etaHours, 0) * 10) / 10} ч`);
      console.log(`  план записан: ${file}`);
      console.log(`  порядок для очереди:\n    ${merged.filter((p) => p.left > 0).map((p) => p.host).join(' ')}`);
      break;
    }
    case 'facts': {
      const st = await facts.run({ limit: Number(flag('limit', 500)), reparse: argv.includes('--reparse') });
      console.log(`  разобрано документов ${st.docs}: машин ${st.vehicles}, `
        + `совместимостей ${st.fitment}, комплектующих ${st.parts}`);
      break;
    }
    case 'stats': {
      const s = await store.stats();
      if (!s.db) return console.log(`базы нет (SASHALAB_PG_URL), отладочная выгрузка в ${s.out}`);
      console.log(`  источников ${s.sources}, документов ${s.documents} (не разобрано ${s.unparsed}),`
        + ` машин ${s.vehicles}, комплектующих ${s.parts}, совместимостей ${s.fitment}`);
      break;
    }
    default:
      console.log(HELP);
  }
}

main().then(() => db.enabled && db.close())
  .catch((e) => { console.error('ошибка:', e.message); process.exit(1); });
