// Реестр источников базы знаний. Три этапа сбора, по возрастанию ценности:
//
//   1) works — сайты с примерами работ. Отвечают на вопрос «что вообще ставят
//      и на какие машины». Мало текста, много конкретики: марка + линза + цена.
//   2) parts — каталоги комплектующих. Отвечают «что физически существует
//      на рынке»: линзы, блоки, маски, стёкла, посадочные диаметры, цены.
//   3) community — Drive2 и телеграм-канал. Самое ценное и самое грязное:
//      живой опыт установщиков, ошибки, «на этой фаре крепление ломается».
//
// ⚠ Что мы с этим делаем и чего НЕ делаем. Собранный текст — рабочий материал
// для разбора фактов (см. harvest/facts.js) и остаётся в базе. На сайт уходят
// только СВОИ формулировки и проверенные студией данные, со ссылкой на источник,
// где это уместно. Перепечатка чужих статей — это и нарушение ст. 1270 ГК,
// и дубль в индексе, который поисковик засчитает не нам.
const { BROWSER_UA } = require('./http');

const SOURCES = [
  // ── этап 1: примеры работ ────────────────────────────────────────────────
  { host: 'www.xenonshop.ru', kind: 'works', title: 'Xenonshop',
    seeds: ['https://www.xenonshop.ru/'],
    include: /\/(blog|stati|articles|nashi-raboty|works|catalog)\//i, delayMs: 4000, maxPages: 250 },
  { host: 'www.galogenu.net', kind: 'works', title: 'Галогену.нет',
    seeds: ['https://www.galogenu.net/'],
    include: /\/(blog|stati|articles|works|raboty|catalog)\//i, delayMs: 4000, maxPages: 250 },
  { host: 'autosvet.pro', kind: 'works', title: 'Autosvet.pro',
    seeds: ['https://autosvet.pro/'], include: /./, delayMs: 4000, maxPages: 250 },
  { host: 'hltuning.ru', kind: 'works', title: 'HL Tuning',
    seeds: ['https://hltuning.ru/'],
    // robots этого сайта запрещает /tpost/ и /catalog/ — загрузчик их и не возьмёт,
    // здесь фильтр только сужает область до осмысленного.
    include: /./, delayMs: 4000, maxPages: 150 },

  // ── этап 2: комплектующие ────────────────────────────────────────────────
  { host: 'luxsar.ru', kind: 'parts', title: 'Luxsar',
    seeds: ['https://luxsar.ru/'], include: /./, delayMs: 4000, maxPages: 400 },
  { host: 'legal-xenon.ru', kind: 'parts', title: 'Legal Xenon',
    seeds: ['https://legal-xenon.ru/'], include: /./, delayMs: 4000, maxPages: 400 },
  { host: 'vdf-light.ru', kind: 'parts', title: 'VDF Light',
    seeds: ['https://vdf-light.ru/'], include: /./, delayMs: 4000, maxPages: 400 },
  { host: 'www.criline.ru', kind: 'parts', title: 'Criline',
    seeds: ['https://www.criline.ru/'], include: /./, delayMs: 4000, maxPages: 300 },
  { host: 'steklafar.ru', kind: 'parts', title: 'Стёкла фар',
    seeds: ['https://steklafar.ru/'], include: /./, delayMs: 4000, maxPages: 300 },

  // ── этап 3: сообщество ───────────────────────────────────────────────────
  // Drive2 стоит за DDoS-Guard: на «ботовый» User-Agent приходит js-челлендж
  // вместо страницы, а robots.txt недоступен вовсе. Отсюда браузерный UA,
  // увеличенная пауза и жёсткий потолок страниц: мы гости, а не нагрузка.
  { host: 'www.drive2.ru', kind: 'community', title: 'Drive2',
    seeds: [
      'https://www.drive2.ru/experience/',
      'https://www.drive2.ru/search/?q=%D0%B1%D0%B8%D0%BB%D0%B5%D0%B4+%D0%BB%D0%B8%D0%BD%D0%B7%D1%8B',
      'https://www.drive2.ru/search/?q=%D1%80%D0%B5%D0%BC%D0%BE%D0%BD%D1%82+%D1%84%D0%B0%D1%80',
    ],
    include: /\/(l|b|c)\//,          // записи бортжурналов и посты
    ua: BROWSER_UA, delayMs: 8000, maxPages: 200,
    note: 'DDoS-Guard: robots.txt недоступен, ходим браузерным UA, пауза 8 с, потолок 200 страниц' },
];

const byHost = (host) => SOURCES.find((s) => s.host === host || s.host === `www.${host}`);
const byKind = (kind) => SOURCES.filter((s) => s.kind === kind);

module.exports = { SOURCES, byHost, byKind };
