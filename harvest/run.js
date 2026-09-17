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
//   node harvest/run.js facts [--limit 500]     — разбор скачанного в факты
//   node harvest/run.js stats                   — что накоплено
//
// Сбор идёт медленно НАМЕРЕННО (пауза на источник, потолок страниц за заход):
// это не «медленно», это условие, при котором нас не закроют на второй день.
const path = require('path');
require('../server-env')(path.join(__dirname, '..', 'seo', '.env'));

const { SOURCES, byHost, byKind } = require('./sources');
const crawl = require('./crawl');
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
