#!/usr/bin/env node
// Командная строка SEO-модуля. Ключи берутся из окружения (seo/.env.example).
require('../server-env')(require('path').join(__dirname, '.env'));
const jobs = require('./lib/jobs');
const store = require('./lib/store');
const db = require('./lib/db');

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};

const HELP = `
sasha-lab · SEO

  wordstat [фраза ...]      частотность по фразам (по умолчанию — базовый список)
                            20 ₽/вызов; --force (игнорировать 30-дн. кэш), --max N
                            --test: без API и без денег, ответы из фикстуры
                            --clear-test: убрать тестовые фразы из базы
  answers [--min 50]        раздел /baza/otvety/: что закрыто ответом, что в очереди
  positions [--limit 30]    снять позиции по самым частотным фразам
  webmaster [--from --to]   реальные запросы сайта из Яндекс.Вебмастера
  gsc [--from --to]         реальные запросы сайта из Google Search Console
  gaps [--min 30]           частотные фразы, под которые нет страницы
  report                    сводка

  memory                    прогнать семантику через сео-память (одна фраза — один адрес)
  queue [--limit 20]        что писать дальше: новые страницы и что усилить
  demand [--limit 30]       ⟳ полный цикл спроса: Wordstat + GSC + Вебмастер → память
                            --cheap: без Wordstat (он платный) — для прогонов несколько раз в день
  autopages [--limit 2]     написать страницы под верх очереди спроса (--dry: только показать)
  drafts                    автостраницы, ждущие решения владельца
  publish <slug>            опубликовать автостраницу-черновик

  questions [--status new]  очередь вопросов посетителей

Окружение: SASHALAB_PG_URL (база), YANDEX_SEARCH_API_KEY, YANDEX_FOLDER_ID,
YANDEX_WEBMASTER_TOKEN, GSC_KEY_FILE, GSC_SITE, SEO_DOMAIN.
`;

async function main() {
  switch (cmd) {
    case 'wordstat': {
      // Фразы — всё, что не флаг и не значение флага («--max 1» — не фраза «1»).
      const phrases = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] || '').startsWith('--'));
      if (argv.includes('--clear-test')) {
        console.log(`убрано тестовых фраз: ${await jobs.clearTestKeywords()}`);
        break;
      }
      const test = argv.includes('--test');
      const r = await jobs.collectWordstat(phrases.length ? phrases : undefined,
        { force: argv.includes('--force'), test,
          maxCalls: Number(flag('max', undefined) ?? jobs.WORDSTAT_MAX_CALLS) });
      if (test) console.log('ТЕСТОВЫЙ прогон: цифры из фикстуры, денег не потрачено, источник wordstat-test');
      for (const c of r.collected) console.log(`  ${c.seed}: всего ${c.total}, собрано фраз ${c.got}`);
      for (const s of r.skipped) console.log(`  · ${s.seed}: пропущено — ${s.why}`);
      for (const e of r.errors) console.error(`  ! ${e.seed}: ${e.error}`);
      console.log(`вызовов Wordstat: ${r.calls}, оплачено ${r.billed} (≈${r.rub} ₽), всего с начала: ${r.spend.calls} (≈${r.spend.rub} ₽)`);
      console.log(`в базе фраз: ${await store.keywords.count()}`);
      break;
    }
    case 'answers': {
      const r = await jobs.answersDemand({ minCount: Number(flag('min', 50)), limit: Number(flag('limit', 40)) });
      console.log(`страниц-ответов в разделе: ${r.answers}${r.test ? '  (в базе есть ТЕСТОВЫЕ фразы wordstat-test)' : ''}`);
      console.log('ЗАКРЫТО:');
      for (const c of r.covered.slice(0, 40)) console.log(`  ${String(c.demand).padStart(7)}  ${c.phrase}  →  ${c.url} [${c.kind}]`);
      console.log('В ОЧЕРЕДЬ НА ОТВЕТ (спрос есть, страницы нет):');
      for (const q of r.queue) console.log(`  ${String(q.demand).padStart(7)}  ${q.phrase}${q.url ? `   ближайшее: ${q.url} (${q.score})` : ''}`);
      break;
    }
    case 'positions': {
      const limit = Number(flag('limit', 30));
      const phrases = (await store.keywords.rows())
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
      const rows = await jobs.gaps({ minCount: Number(flag('min', 30)) });
      for (const r of rows) console.log(`  ${String(r.count || r.shows).padStart(7)}  ${r.phrase}`);
      console.log(`не закрыто страницами: ${rows.length}`);
      break;
    }
    case 'questions': {
      const rows = await require('./questions').list(flag('status', 'new'));
      for (const q of rows) console.log(`  ${q.at.slice(0, 16).replace('T', ' ')}  ${q.status.padEnd(9)} ${q.name} — ${q.text.slice(0, 70)}`);
      console.log(`всего: ${rows.length}`);
      break;
    }
    case 'memory': {
      const mem = require('./lib/memory');
      const mats = await require('../content/materials').coverageMetas();
      const kws = await store.keywords.rows();
      if (!kws.length) return console.error('семантики нет: сначала «wordstat» или «gsc»');
      const r = await mem.sync(mats, kws);
      console.log(`  фраз ${r.items.length}: уже закрыто ${r.covered}, `
        + `дописать в существующие ${r.strengthen}, заслуживают своей страницы ${r.new}`);
      break;
    }
    case 'queue': {
      const mem = require('./lib/memory');
      const q = await mem.queue({ limit: Number(flag('limit', 20)) });
      console.log('НОВЫЕ СТРАНИЦЫ (нет своего адреса):');
      for (const r of q.new) console.log(`  ${String(r.demand ?? '—').padStart(7)}  ${r.phrase}`);
      console.log('УСИЛИТЬ СУЩЕСТВУЮЩИЕ (не плодить дубли):');
      for (const r of q.strengthen) console.log(`  ${String(r.demand ?? '—').padStart(7)}  ${r.phrase}  →  /baza/${r.target_slug}/`);
      break;
    }
    // Полный цикл «изменение спроса на автомате»: источники → семантика → память.
    // Ставится в cron раз в неделю; каждый шаг падает по отдельности и не роняет
    // остальные — данные Вебмастера не должны теряться из-за просроченного ключа Google.
    case 'demand': {
      const mem = require('./lib/memory');
      const runId = await store.runs.start('demand');
      const stats = {};
      // Wordstat платный (20 ₽/вызов): в частых дневных прогонах его пропускаем,
      // бесплатные Вебмастер и Search Console дают тот же свежий спрос.
      const test = argv.includes('--test');
      const sources = argv.includes('--cheap')
        ? [['webmaster', () => jobs.pullWebmaster({})], ['gsc', () => jobs.pullGsc({})]]
        : [['wordstat', () => jobs.collectWordstat(undefined, { test })], ['webmaster', () => jobs.pullWebmaster({})], ['gsc', () => jobs.pullGsc({})]];
      for (const [name, fn] of sources) {
        try { const r = await fn(); stats[name] = Array.isArray(r) ? r.length : r.collected?.length ?? 0; }
        catch (e) { stats[name] = `ошибка: ${e.message.slice(0, 120)}`; console.error(`  ! ${name}: ${e.message}`); }
      }
      const mats = await require('../content/materials').coverageMetas();
      const r = await mem.sync(mats, await store.keywords.rows());
      stats.memory = { covered: r.covered, strengthen: r.strengthen, new: r.new };
      await store.runs.finish(runId, { ok: true, stats });
      console.log(JSON.stringify(stats, null, 2));
      break;
    }
    case 'autopages': {
      const writer = require('./lib/writer');
      const runId = await store.runs.start('autopages');
      const r = await writer.run({ limit: Number(flag('limit', 2)), dry: argv.includes('--dry') });
      for (const w of r.written) console.log(`  + ${w.published ? 'опубликовано' : 'черновик  '} /baza/${w.slug || '—'}/  ${w.title}`);
      for (const s2 of r.skipped) console.log(`  · пропущено «${s2.phrase}»: ${s2.why}`);
      for (const e of r.errors) console.error(`  ! ${e.phrase}: ${e.error}`);
      await store.runs.finish(runId, { ok: !r.errors.length, stats: { written: r.written.length, skipped: r.skipped.length, errors: r.errors.length } });
      console.log(`написано страниц: ${r.written.length}`);
      break;
    }
    case 'drafts': {
      const rows = await require('./lib/writer').drafts();
      for (const d of rows) console.log(`  ${d.slug}\n      ${d.title}${d.auto_note ? `\n      чего не хватило: ${d.auto_note}` : ''}`);
      console.log(`черновиков: ${rows.length}`);
      break;
    }
    case 'publish': {
      if (!argv[1]) return console.error('нужен slug: seo publish <slug>');
      await require('./lib/writer').publishDraft(argv[1]);
      console.log(`опубликовано: /baza/${argv[1]}/`);
      break;
    }
    case 'report': {
      console.log(JSON.stringify(await jobs.summary(), null, 2));
      break;
    }
    default:
      console.log(HELP);
  }
}

main()
  .then(() => db.enabled && db.close())
  .catch((e) => { console.error('ошибка:', e.message); process.exit(1); });
