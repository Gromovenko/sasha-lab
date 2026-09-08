#!/usr/bin/env node
// Командная строка SEO-модуля. Ключи берутся из окружения (seo/.env.example).
const jobs = require('./lib/jobs');
const store = require('./lib/store');

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};

const HELP = `
sasha-lab · SEO

  wordstat [фраза ...]      частотность по фразам (по умолчанию — базовый список)
  positions [--limit 30]    снять позиции по самым частотным фразам
  webmaster [--from --to]   реальные запросы сайта из Яндекс.Вебмастера
  gsc [--from --to]         реальные запросы сайта из Google Search Console
  gaps [--min 30]           частотные фразы, под которые нет страницы
  report                    сводка

Окружение: YANDEX_SEARCH_API_KEY, YANDEX_FOLDER_ID, YANDEX_WEBMASTER_TOKEN,
GSC_KEY_FILE, GSC_SITE, SEO_DOMAIN.
`;

async function main() {
  switch (cmd) {
    case 'wordstat': {
      const phrases = argv.slice(1).filter((a) => !a.startsWith('--'));
      const r = await jobs.collectWordstat(phrases.length ? phrases : undefined);
      for (const c of r.collected) console.log(`  ${c.seed}: всего ${c.total}, собрано фраз ${c.got}`);
      for (const e of r.errors) console.error(`  ! ${e.seed}: ${e.error}`);
      console.log(`в базе фраз: ${Object.keys(store.keywords.all()).length}`);
      break;
    }
    case 'positions': {
      const limit = Number(flag('limit', 30));
      const phrases = Object.values(store.keywords.all())
        .sort((a, b) => (b.count || b.shows || 0) - (a.count || a.shows || 0))
        .slice(0, limit).map((k) => k.phrase);
      if (!phrases.length) return console.error('нечего проверять: сначала «wordstat»');
      const r = await jobs.checkPositions(phrases);
      for (const c of r.checked) console.log(`  ${c.pos ? String(c.pos).padStart(3) : '  —'}  ${c.phrase}`);
      for (const e of r.errors) console.error(`  ! ${e.phrase}: ${e.error}`);
      break;
    }
    case 'webmaster': {
      const rows = await jobs.pullWebmaster({ dateFrom: flag('from'), dateTo: flag('to') });
      for (const r of rows.slice(0, 40)) console.log(`  ${String(r.shows).padStart(6)} показов, поз. ${r.position ?? '—'}  ${r.query}`);
      console.log(`всего запросов: ${rows.length}`);
      break;
    }
    case 'gsc': {
      const rows = await jobs.pullGsc({ dateFrom: flag('from'), dateTo: flag('to') });
      for (const r of rows.slice(0, 40)) console.log(`  ${String(r.impressions).padStart(6)} показов, поз. ${r.position.toFixed(1)}  ${r.query}`);
      console.log(`всего запросов: ${rows.length}`);
      break;
    }
    case 'gaps': {
      const rows = jobs.gaps({ minCount: Number(flag('min', 30)) });
      for (const r of rows) console.log(`  ${String(r.count || r.shows).padStart(7)}  ${r.phrase}`);
      console.log(`не закрыто страницами: ${rows.length}`);
      break;
    }
    case 'report': {
      console.log(JSON.stringify(jobs.summary(), null, 2));
      break;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => { console.error('ошибка:', e.message); process.exit(1); });
