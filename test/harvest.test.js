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
