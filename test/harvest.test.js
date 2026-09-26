// Тесты сбора базы знаний. Сети и базы не требуют: загрузчик подменяется,
// хранилище без SASHALAB_PG_URL пишет во временную папку.
//
// Сторожат ровно то, что ломается молча и потом живёт в базе годами:
// разбор robots чужого сайта, разбор карты сайта с чужим именем хоста,
// заголовок темы из адреса и разбор английского заголовка в факт.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.HARVEST_OUT = path.join(os.tmpdir(), 'sashalab-harvest-test');

const http = require('../harvest/http');
const crawl = require('../harvest/crawl');
const facts = require('../harvest/facts');
const vehicles = require('../harvest/vehicles');
const { byHost } = require('../harvest/sources');

// robots.txt hidplanet.com, снят 17.09.2026
const HIDPLANET_ROBOTS = `Sitemap: https://www.hidplanet.com/core/xmlsitemap.php

User-agent: *
Crawl-delay: 10
Disallow: /admincp/
Disallow: /members/
Disallow: /search/

User-agent: GPTBot
Crawl-delay: 10
Disallow: /
`;

test('robots hidplanet: темы можно, личные разделы нельзя, пауза 10 с', () => {
  const rules = http.parseRobots(HIDPLANET_ROBOTS);
  assert.equal(rules.delay, 10000);
  assert.ok(http.allowedBy(rules, '/forum/general-discussion/leds/49651-monte-carlo'));
  assert.ok(http.allowedBy(rules, '/core/xmlsitemap.php?fn=vbulletin_sitemap_starter_1.xml.gz'));
  assert.ok(!http.allowedBy(rules, '/members/12345-somebody'));
  assert.ok(!http.allowedBy(rules, '/search/?q=morimoto'));
  // Запрет GPTBot — это чужая секция, на нашу она не распространяется,
  // но и брать у площадки мы будем только заголовки (см. sources.js).
  assert.ok(http.allowedBy(rules, '/articles/1375080-hid-newb-crash-course'));
});

test('заголовок темы достаётся из адреса', () => {
  assert.equal(
    crawl.titleFromUrl('https://www.hidplanet.com/forum/general-discussion/specific-questions/60453-tsx-r-vs-black-series-clear-lens'),
    'tsx r vs black series clear lens');
  // Мусор кодировки в имени раздела не должен приезжать в заголовок
  assert.equal(
    crawl.titleFromUrl('https://www.hidplanet.com/forum/general-discussion/shrouds-ccfl%C2%92s-angel-eyes/35862-vacuum-forming-shrouds'),
    'vacuum forming shrouds');
});

// Карта сайта vBulletin печатает ВНУТРЕННЕЕ имя хоста. Без подмены мы бы ушли
// ходить по чужому домену, которого нет ни в одном robots.txt.
const SITEMAP_INDEX = `<?xml version="1.0"?><sitemapindex>
<sitemap><loc>http://5da7a14b4a42-006150.vbulletin.net/core/xmlsitemap.php?fn=part_1.xml.gz</loc></sitemap>
</sitemapindex>`;
const SITEMAP_PART = `<?xml version="1.0"?><urlset>
<url><loc>http://5da7a14b4a42-006150.vbulletin.net/forum/general-discussion/leds/49651-2010-hyundai-sonata-morimoto-retrofit</loc>
<lastmod>2013-11-24T17:00:31+00:00</lastmod></url>
<url><loc>http://5da7a14b4a42-006150.vbulletin.net/forum/general-discussion/leds/49652-monte-carlo-sequential-conversion</loc></url>
<url><loc>http://5da7a14b4a42-006150.vbulletin.net/articles/900-morimoto-mini-h1-guide</loc></url>
<url><loc>http://5da7a14b4a42-006150.vbulletin.net/members/777-somebody</loc></url>
<url><loc>http://5da7a14b4a42-006150.vbulletin.net/forum/the-marketplace/12-fs-morimoto-mini-h1</loc></url>
</urlset>`;

function stubHttp({ robots = HIDPLANET_ROBOTS } = {}) {
  const real = { get: http.get, robots: http.robots, raw: http.raw };
  const asked = [];
  http.robots = async () => http.parseRobots(robots);
  http.get = async (url) => {
    asked.push(url);
    if (/xmlsitemap\.php$/.test(url)) return { url, status: 200, body: SITEMAP_INDEX };
    if (/fn=part_1/.test(url)) return { url, status: 200, body: SITEMAP_PART };
    return { url, status: 404, body: '' };
  };
  return { asked, restore: () => Object.assign(http, real) };
}

test('карта сайта: чужое имя хоста правится, lastmod читается', async () => {
  const s = stubHttp();
  try {
    const out = await crawl.sitemapUrls('www.hidplanet.com', {
      seeds: ['https://www.hidplanet.com/core/xmlsitemap.php'], hostFix: true,
    });
    assert.equal(out.length, 5);
    assert.ok(out.every((e) => new URL(e.loc).hostname === 'www.hidplanet.com'));
    assert.ok(out.every((e) => e.loc.startsWith('https://')));
    assert.equal(out[0].lastmod, '2013-11-24T17:00:31+00:00');
  } finally { s.restore(); }
});

test('без hostFix адреса с чужого хоста не берём', async () => {
  const s = stubHttp();
  try {
    const out = await crawl.sitemapUrls('www.hidplanet.com', {
      seeds: ['https://www.hidplanet.com/core/xmlsitemap.php'],
    });
    assert.equal(out.length, 0);
  } finally { s.restore(); }
});

test('режим заголовков: страницы не качаем, запрещённое и пустое не сохраняем', async () => {
  // robots в этом заходе дополнительно закрывает /articles/ — проверяем, что
  // запрет площадки действует и там, где страницу мы даже не открываем.
  const s = stubHttp({ robots: HIDPLANET_ROBOTS.replace('Disallow: /search/', 'Disallow: /search/\nDisallow: /articles/') });
  const saved = [];
  try {
    const stat = await crawl.crawlSource(byHost('hidplanet.com'), {
      onDoc: (doc) => { saved.push(doc); },
    });
    // Ни одного захода за html — только карта сайта.
    assert.ok(s.asked.every((u) => /xmlsitemap\.php/.test(u)), s.asked.join(' '));
    assert.equal(stat.listed, 2);      // /members/ и the-marketplace — вне разделов сбора
    assert.equal(stat.robots, 1);      // /articles/ — запрет площадки
    assert.equal(stat.offtopic, 1);    // «monte carlo sequential conversion» — ни машины, ни линзы
    assert.equal(saved.length, 1);
    assert.equal(saved[0].title, '2010 hyundai sonata morimoto retrofit');
    assert.equal(saved[0].text, saved[0].title);   // чужого текста в базе нет
    assert.equal(saved[0].url,
      'https://www.hidplanet.com/forum/general-discussion/leds/49651-2010-hyundai-sonata-morimoto-retrofit');
    assert.equal(saved[0].meta.lang, 'en');
    assert.equal(saved[0].meta.from, 'sitemap-title');
    assert.equal(saved[0].published_at.getUTCFullYear(), 2013);
  } finally { s.restore(); }
});

test('английский заголовок разбирается в факт', () => {
  const doc = {
    title: '2010 hyundai sonata retrofit: baked the headlights, morimoto mini h1',
    text: '2010 hyundai sonata retrofit: baked the headlights, morimoto mini h1',
    meta: { kind: 'community', lang: 'en' },
  };
  const out = facts.parseDoc(doc);
  assert.deepEqual(out.vehicles.map((v) => v.slug), ['hyundai-sonata']);
  assert.equal(out.vehicles[0].yearFrom, 2010);
  const f = out.fitment.find((x) => x.lens.startsWith('morimoto'));
  assert.ok(f, JSON.stringify(out.fitment));
  assert.equal(f.approach, 'со вскрытием');
  assert.equal(f.needs_opening, true);
});

test('английский жаргон света не превращается в машины', () => {
  // «mini h1» на форуме ретрофита — это линза Morimoto Mini, а не BMW Mini
  assert.deepEqual(vehicles.detect('morimoto mini h1 5 0 bi xenon projectors', { lang: 'en' }), []);
  assert.deepEqual(vehicles.detect('mini cooper retrofit', { lang: 'en' }).map((v) => v.slug),
    ['mini-cooper']);
  // Слова про свет за маркой — не модель
  assert.deepEqual(vehicles.detect('2010 hyundai sonata clear lens upgrade', { lang: 'en' })
    .map((v) => v.slug), ['hyundai-sonata']);
  assert.deepEqual(vehicles.detect('1st gen honda insight morimoto retrofit', { lang: 'en' })
    .map((v) => v.slug), ['honda-insight']);
  // Живая речь после модели тоже не модель
  assert.deepEqual(vehicles.detect('ford ranger looking for advice', { lang: 'en' })
    .map((v) => v.slug), ['ford-ranger']);
});

test('русский разбор не изменился', () => {
  assert.deepEqual(vehicles.detect('Линзы Aozoom A3+ в Haval Jolion 2021 со вскрытием')
    .map((v) => v.slug), ['haval-jolion']);
  assert.deepEqual(vehicles.detect('Переходные рамки Kia Rio 4 рестайлинг')
    .map((v) => v.slug), ['kia-rio-4']);
  const out = facts.parseDoc({
    title: 'Установка линз Aozoom A3+ 3" в Haval Jolion',
    text: 'Поставили линзы Aozoom A3+ 3" в Haval Jolion со вскрытием фары, работа заняла 4 часа.',
    meta: { kind: 'works' },
  });
  const f = out.fitment[0];
  assert.equal(f.vehicleSlug, 'haval-jolion');
  assert.equal(f.lens, 'aozoom a3+ 3"');
  assert.equal(f.approach, 'со вскрытием');
  assert.equal(f.hours, 4);
});

test('завод. конструктив фары: герметик, адаптивный свет, источник ближнего света, заводская линза', () => {
  const out = facts.parseDoc({
    title: 'Haval Jolion: фара на полиуретановом герметике, заводская линза Koito, есть адаптивный свет (AFS), со штатным ксеноном',
    text: 'Haval Jolion: фара на полиуретановом герметике, заводская линза Koito, есть адаптивный свет (AFS), со штатным ксеноном. Поставили линзы Aozoom A3+.',
    meta: { kind: 'works' },
  });
  const f = out.fitment[0];
  assert.equal(f.sealant, 'полиуретановый герметик');
  assert.equal(f.adaptive, true);
  assert.equal(f.low_beam_source, 'штатный ксенон');
  assert.equal(f.factory_lens, 'Koito');
});

// ── скорость сбора: замер и штраф за 429 ───────────────────────────────────
// Сторожат две вещи, которые ломаются молча и дорого: рекомендация паузы
// (ошибка вниз = бан на источнике, ошибка вверх = лишние сутки захода) и
// исполнение отказа «слишком часто» — без него измеренная быстрая пауза
// превращает накопительный лимитер площадки в стену из 429.
const probe = require('../harvest/probe');

test('probe: пауза не быстрее 1 запроса в секунду и не быстрее Crawl-delay', () => {
  // Сайт выдержал 300 мс — всё равно не разгоняемся быстрее секунды.
  assert.equal(probe.recommend({ lastGood: 300 }), 1000);
  // Запас 1.5 к последней прошедшей ступени.
  assert.equal(probe.recommend({ lastGood: 4000 }), 6000);
  // Лесенка не запускалась (Crawl-delay медленнее любой ступени) — берём его.
  assert.equal(probe.recommend({ robotsDelay: 10000, now: 10000 }), 10000);
  assert.equal(probe.recommend({ robotsDelay: 40000, now: 40000 }), 40000);
  // Первая же ступень отказала — отходим от неё вдвое.
  assert.equal(probe.recommend({ steps: [{ delay: 4000, ok: false, bad: 429 }], now: 4000 }), 8000);
  // Потолок: медленнее 40 с не ходим никуда.
  assert.equal(probe.recommend({ robotsDelay: 30000, lastGood: 0, steps: [{ delay: 30000 }] }), 40000);
});

test('загрузчик: 429 поднимает паузу этому хосту до конца захода', async () => {
  const nodeHttp = require('node:http');
  const codes = [429, 200];
  const srv = nodeHttp.createServer((req, res) => {
    res.writeHead(codes.shift() || 200, { 'content-type': 'text/html' });
    res.end('<html>ок</html>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    http.penalty.delete('127.0.0.1');
    const t0 = Date.now();
    const first = await http.get(`${base}/a`, { delayMs: 100, useCache: false });
    assert.equal(first.status, 429);
    assert.equal(http.penalty.get('127.0.0.1'), 200, 'пауза удвоена самим источником');
    const second = await http.get(`${base}/b`, { delayMs: 100, useCache: false });
    assert.equal(second.status, 200);
    // Вторая ходка ждала уже поднятую паузу, а не исходные 100 мс.
    assert.ok(Date.now() - t0 >= 200, 'штраф не исполнен');
  } finally {
    http.penalty.delete('127.0.0.1');
    srv.close();
  }
});

// Параллельные запросы к одному хосту — это ускорение НАС, а не давление на
// источник: интервал между стартами обязан остаться прежним. Сторожит то, что
// ломается молча (залп из трёх запросов в одну секунду = бан по IP на второй
// день) и то, ради чего правка делалась (ожидание ответа больше не
// складывается с паузой).
test('загрузчик: три параллельных запроса к хосту идут через паузу, а не залпом', async () => {
  const nodeHttp = require('node:http');
  const starts = [];
  const srv = nodeHttp.createServer((req, res) => {
    starts.push(Date.now());
    // Ответ заметно дольше паузы: старая схема ждала паузу ПОСЛЕ ответа и
    // растягивала заход до max(пауза, ответ) на страницу.
    setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>ок</html>'); }, 300);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    http.penalty.delete('127.0.0.1');
    http.nextFree.delete('127.0.0.1');
    const t0 = Date.now();
    const rs = await Promise.all([1, 2, 3].map((i) =>
      http.get(`http://127.0.0.1:${port}/p${i}`, { delayMs: 150, useCache: false })));
    const spent = Date.now() - t0;
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
    starts.sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i += 1) {
      assert.ok(starts[i] - starts[i - 1] >= 140,
        `запросы ушли залпом: интервал ${starts[i] - starts[i - 1]} мс`);
    }
    // Последовательно это было бы 3 × (150 + 300) = 1350 мс.
    assert.ok(spent < 1000, `ожидание ответа всё ещё складывается с паузой: ${spent} мс`);
  } finally {
    http.penalty.delete('127.0.0.1');
    http.nextFree.delete('127.0.0.1');
    srv.close();
  }
});

test('план скорости: свежий перекрывает реестр, старый и слишком быстрый — нет', () => {
  const fs = require('fs');
  const { applySpeedPlan } = require('../harvest/sources');
  const file = path.join(os.tmpdir(), 'sashalab-speed-plan.json');
  const list = () => ([{ host: 'a.ru', delayMs: 4000 }, { host: 'b.ru', delayMs: 4000 },
    { host: 'c.ru', delayMs: 40000 }]);

  fs.writeFileSync(file, JSON.stringify({ measuredAt: new Date().toISOString(),
    plan: [{ host: 'a.ru', recommend: 1000 }, { host: 'b.ru', recommend: 200 }] }));
  const fresh = applySpeedPlan(list(), file);
  assert.equal(fresh[0].delayMs, 1000, 'измеренная пауза применена');
  assert.equal(fresh[1].delayMs, 4000, 'быстрее секунды не принимаем ни при каком замере');
  assert.equal(fresh[2].delayMs, 40000, 'источника нет в плане — остаётся как в реестре');

  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  fs.writeFileSync(file, JSON.stringify({ measuredAt: old, plan: [{ host: 'a.ru', recommend: 1000 }] }));
  assert.equal(applySpeedPlan(list(), file)[0].delayMs, 4000, 'замер старше 30 дней не берём');

  fs.writeFileSync(file, 'это не json');
  assert.equal(applySpeedPlan(list(), file)[0].delayMs, 4000, 'битый план не роняет сбор');
  fs.unlinkSync(file);
});

test('links: нормализация адреса и заголовка даёт границы слага марка-модель', () => {
  const { NORM } = require('../harvest/links');
  assert.match(NORM("'x'"), /regexp_replace\(lower\('x'\)/);
  // тот же приём в JS: слаг не должен липнуть к чужой модели
  const norm = (s) => '-' + s.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-';
  const hit = (url, slug) => norm(url).includes(`-${slug}-`);
  assert.ok(hit('https://electro-kot.ru/haval/jolion/2021', 'haval-jolion'));
  assert.ok(!hit('https://x.ru/haval/jolion-pro', 'haval-jolion-max'));
  assert.ok(!hit('https://x.ru/mazda/30', 'mazda-3'));
});

test('sources: исчерпанные источники выключены, недобранные остались в заходе', () => {
  const { SOURCES, EXHAUSTED } = require('../harvest/sources');
  // Каждый хост из списка исчерпанных должен существовать в реестре: опечатка
  // в ключе иначе тихо оставила бы сайт в недельном заходе.
  for (const host of Object.keys(EXHAUSTED)) {
    const src = SOURCES.find((s) => s.host === host);
    assert.ok(src, `${host} есть в реестре`);
    assert.equal(src.enabled, false, `${host} выключен`);
    assert.match(src.note, /исчерпан \(\d\d\.09\.2026\)/, `${host} объясняет причину`);
  }
  // Недобранные источники выключение не задело — иначе сбор встал бы весь.
  for (const host of ['vdf-light.ru', 'daoptika.ru', 'xenonru.ru']) {
    assert.notEqual(SOURCES.find((s) => s.host === host).enabled, false, `${host} остался в заходе`);
  }
});

// ── карточка машины: стекло, корпус, переходная рамка, разбор, герметик ────
// Сторожит два правила, которые тихо ломают всю карточку: «корпус фары» до этого
// уезжал в линзы (общее правило /линз|модул/), а бутил не отличался от битума —
// а для мастера это и есть ответ «греть или не греть».
test('виды деталей: корпус фары, стекло, переходная рамка', () => {
  assert.equal(facts.kindOf('Корпус фары правый Toyota Camry 70 под линзы'), 'housing');
  assert.equal(facts.kindOf('Блок-фара в сборе Kia Rio 4'), 'housing');
  assert.equal(facts.kindOf('Стекло фары Haval Jolion левое'), 'glass');
  assert.equal(facts.kindOf('Переходные рамки для би-лед модулей Kia Rio 4'), 'adapter');
  assert.equal(facts.kindOf('Линзы Aozoom A3+ 3 дюйма'), 'lens');
});

test('герметик: бутил отличается от полиуретана и не путается с битумом', () => {
  const seal = (text) => facts.parseDoc({
    title: 'Haval Jolion', text: `${text} Поставили линзы Aozoom A3+.`, meta: { kind: 'works' },
  }).fitment[0].sealant;
  assert.equal(seal('Фара Haval Jolion собрана на бутиловом герметике, греется феном.'), 'бутиловый герметик');
  assert.equal(seal('Headlight on butyl sealant, bake at 110C. Haval Jolion.'), 'бутиловый герметик');
  assert.equal(seal('Haval Jolion: фара на полиуретановом герметике, не разбирается.'), 'полиуретановый герметик');
});

// ── штатное исполнение фары: адаптив, ближний с завода, обманки, цоколи ────
// Сторожит выгрузку: поля 9–12 считаются в виде vehicle_catalog (миграция 008),
// и единственное место, где их легко потерять, — столбцы CSV для человека.
test('карточка машины: в выгрузке есть штатный свет, обманки и цоколи ламп', () => {
  const catalog = require('../harvest/catalog');
  const csv = catalog.toCsv([{
    make: 'toyota', model: 'Corolla', year_from: 2018, year_to: 2021,
    glass_offers: 3, housing_offers: 0, adapter_offers: 2,
    difficulty: 'лёгкая', teardown_facts: 4, sealant: 'бутил', sealant_facts: 2,
    adaptive: true, adaptive_facts: 3, low_beam: 'ксенон',
    low_beam_raw: 'штатный ксенон', low_beam_facts: 5, factory_lens: 'Koito',
    needs_canbus: true, canbus_offers: 1, canbus_price_min: 1200,
    bulb_sockets: ['H11', 'HB3'], bulb_spots: ['ближний свет', 'дальний свет'],
    shop_url: 'https://shop.example/toyota/corolla/',
    glass_url: 'https://shop.example/glass/1', adapter_url: 'https://shop.example/adapter/2',
    teardown_url: 'https://studio.example/works/3', sealant_url: 'https://studio.example/works/4',
    adaptive_url: 'https://studio.example/works/5', low_beam_url: 'https://studio.example/works/6',
    canbus_url: 'https://shop.example/wire/7', bulb_url: 'https://shop.example/bulb/8',
  }]);
  const [head, row] = csv.split('\n');
  for (const col of ['адаптивный свет', 'штатный ближний', 'нужна обманка',
    'цоколи штатных ламп', 'штатные приборы']) assert.ok(head.includes(col), `нет столбца ${col}`);
  assert.ok(row.includes('"H11, HB3"'), 'цоколи должны идти списком через запятую');
  assert.ok(row.includes('"ближний свет, дальний свет"'), 'приборы должны идти списком');
  assert.ok(row.includes('"ксенон"') && row.includes('"есть"'), 'штатный ближний и обманка');
});

// К каждому из двенадцати пунктов — своя ссылка (миграция 009). Теряется она
// молча: столбец просто исчезает из выгрузки, а «есть/нет» остаётся на месте.
test('карточка машины: у каждого пункта своя рабочая ссылка', () => {
  const catalog = require('../harvest/catalog');
  const row = {
    make: 'toyota', model: 'Corolla',
    shop_url: 'https://shop.example/toyota/corolla/',
    glass_url: 'https://shop.example/glass/1', housing_url: 'https://shop.example/housing/9',
    adapter_url: 'https://shop.example/adapter/2', teardown_url: 'https://studio.example/works/3',
    sealant_url: 'https://studio.example/works/4', adaptive_url: 'https://studio.example/works/5',
    low_beam_url: 'https://studio.example/works/6', canbus_url: 'https://shop.example/wire/7',
    bulb_url: 'https://shop.example/bulb/8',
  };
  const [head, line] = catalog.toCsv([row]).split('\n');
  for (const col of ['магазин по модели', 'ссылка на стекло', 'ссылка на корпус', 'ссылка на рамку',
    'источник о разборе', 'источник о герметике', 'источник об адаптивном', 'источник о ближнем',
    'ссылка на обманку', 'ссылка на лампы']) assert.ok(head.includes(col), `нет столбца ${col}`);
  // каждый адрес доехал до строки, и столбцов ровно столько же, сколько в шапке
  for (const col of catalog.LINK_COLS.filter((c) => row[c])) assert.ok(line.includes(row[col]), `потерян ${col}`);
  assert.equal(line.split(';').length, head.split(';').length);
});

test('виды деталей: обманка CAN-шины и лампа с цоколем', () => {
  assert.equal(facts.kindOf('Обманка DIXEL Ford Focus 3 - 2CanBus'), 'wire');
  assert.equal(facts.kindOf('Лампа ксеноновая D2S Philips 4300K'), 'bulb');
});

// ── карточка машины, пункты 13–18 (миграция 010) ──────────────────────────
test('виды деталей 13–18: фара, блок управления, модуль ДХО, набор для модернизации', () => {
  const k = facts.kindOf;
  assert.equal(k('Фара Toyota Camry 70 оригинал (левая)'), 'headlight_oem');
  assert.equal(k('Фара BMW 5 G30 DEPO (левая)'), 'headlight_analog');
  assert.equal(k('Фара AUDI A7 4K MATRIX (2018-2022) (левая)'), 'headlight', 'без пометки — ни оригинал, ни аналог');
  assert.equal(k('Купить фара диодная 7 в NTS-AUTO'), 'other', 'универсальный прожектор — не штатная фара');
  assert.equal(k('Блок-фара в сборе Kia Rio 4'), 'housing');
  assert.equal(k('Блок управления фарой BMW G30'), 'control');
  assert.equal(k('Блок управления центральным замком 910'), 'other');
  assert.equal(k('Блок розжига штатный Valeo LAD5GL OEM'), 'ballast');
  assert.equal(k('Плата ДХО DIXEL для Q3 I 8U'), 'drl');
  assert.equal(k('Ангельские глазки для Passat B6'), 'drl');
  assert.equal(k('Светодиодные лампы для Audi Q3 в Задние поворотники'), 'bulb', 'лампа поворота — не модуль');
  assert.equal(k('Маски M15-O 1.5 дюйма с 3D-LED анимацией (ДХО / габарит / поворот)'), 'mask');
  assert.equal(k('Toyota Caldina T240 набор линз для фар Hella 3R'), 'kit');
  assert.equal(k('Набор для установки линз в фары Ford Focus [2014-2019]'), 'kit');
  assert.equal(k('Переходные рамки для установки BI-LED Hella 3R'), 'adapter');
});

test('карточка машины: пункты 13–18 в выгрузке с ценой и ссылкой', () => {
  const catalog = require('../harvest/catalog');
  const row = { make: 'audi', model: 'A7' };
  for (const [k] of catalog.EXTRA_ITEMS) {
    row[`${k}_offers`] = 2; row[`${k}_price_min`] = 1000; row[`${k}_url`] = `https://shop.example/${k}`;
  }
  const [head, line] = catalog.toCsv([row]).split('\n');
  for (const [k, title] of catalog.EXTRA_ITEMS) {
    assert.ok(head.includes(title), `нет столбца ${title}`);
    assert.ok(line.includes(`https://shop.example/${k}`), `потеряна ссылка ${k}`);
    assert.ok(catalog.LINK_COLS.includes(`${k}_url`));
  }
  assert.equal(line.split(';').length, head.split(';').length);
});

test('electro-kot: пометка with Xenon в заголовке даёт штатный свет, без пометки — ничего', () => {
  const facts = require('../harvest/facts');
  const doc = (title) => ({ title, text: 'x', url: 'u', source_id: 1, meta: { kind: 'parts', price: 100 } });
  const a = facts.parseDoc(doc('Светодиодные лампы для Peugeot 408 with Xenon 2010-2016 в Дальний свет тип 2'));
  assert.deepEqual(a.vehicles.map((v) => [v.slug, v.yearFrom, v.yearTo]), [['peugeot-408', 2010, 2016]]);
  assert.equal(a.fitment[0].low_beam_source, 'штатный ксенон');
  assert.equal(a.fitment[0].lens, '');
  const b = facts.parseDoc(doc('Светодиодные лампы для BMW 3 (E46) with xenon 2001-2005'));
  assert.equal(b.vehicles[0].slug, 'bmw-3-e46');
  const c = facts.parseDoc(doc('Светодиодные лампы для Toyota C-HR 2016-2019 в Ближний свет'));
  assert.equal(c.fitment.length, 0);
});
