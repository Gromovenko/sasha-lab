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
  // Drive2 ВЫКЛЮЧЕН (09.09.2026): robots.txt отдаёт «User-Agent: * / Disallow: /» —
  // полный запрет всем, кроме поимённо разрешённых поисковиков. Утром того же дня
  // вместо robots приходил js-челлендж DDoS-Guard, и заход обходом казался
  // возможным; при живом запрете обходить его — значит подставить студию
  // (претензия от Drive2 идёт на сайт, чей адрес стоит в User-Agent) и всё равно
  // получить бан через день. Знание Drive2 берём иначе: ссылки на конкретные
  // записи мастер кладёт руками (в очередь материалов), либо Search API отдаёт
  // сниппеты по фразе — они индексируются поисковиками с разрешения площадки.
  { host: 'www.drive2.ru', kind: 'community', title: 'Drive2', enabled: false,
    seeds: [
      'https://www.drive2.ru/experience/',
      'https://www.drive2.ru/search/?q=%D0%B1%D0%B8%D0%BB%D0%B5%D0%B4+%D0%BB%D0%B8%D0%BD%D0%B7%D1%8B',
      'https://www.drive2.ru/search/?q=%D1%80%D0%B5%D0%BC%D0%BE%D0%BD%D1%82+%D1%84%D0%B0%D1%80',
    ],
    include: /\/(l|b|c)\//,          // записи бортжурналов и посты
    ua: BROWSER_UA, delayMs: 8000, maxPages: 200,
    note: 'robots.txt: Disallow: / для всех — автоматический сбор запрещён площадкой (проверено 09.09.2026)' },

  // HIDplanet — англоязычный форум ретрофита фар, 64 тысячи тем с 2006 года:
  // «какая линза встала в такую машину», «что ломается при вскрытии этой фары».
  // Российских источников такой глубины нет, поэтому источник ценен даже при том,
  // что рынок другой: фара у Accord или Sonata одна на весь мир.
  //
  // Берём ТОЛЬКО заголовки тем из карты сайта (mode:'titles'), и вот почему:
  //   * весь html форума закрыт js-челленджем Cloudflare — проверено 17.09.2026
  //     на четырёх User-Agent (наш бот, браузерный, Googlebot) и на настоящем
  //     headless-хромиуме: везде «Just a moment...» и 403. Ни одной страницы
  //     форума мы не скачиваем — обходить защиту не будем, это ровно тот случай,
  //     из-за которого выключен Drive2;
  //   * карта сайта при этом отдаётся свободно (её адрес нестандартный,
  //     /core/xmlsitemap.php, обычный /sitemap.xml тоже под челленджем), а vBulletin
  //     печатает в адресе темы её заголовок — «60453-tsx-r-vs-black-series-clear-lens».
  //     Заголовок сайт публикует для поисковиков сам; этого хватает на факт
  //     «в такую-то машину ставили такую-то линзу» и не даёт ни строки чужого текста.
  // robots.txt площадки (17.09.2026): нашему UA раздел «*» разрешает всё, кроме
  // служебных путей, Crawl-delay 10 — он соблюдается загрузчиком. Отдельно там
  // закрыты GPTBot, CCBot и Google-Extended: площадка против того, чтобы её
  // обсуждения уезжали в обучение моделей. Мы моделей не учим и текста не берём —
  // только факты из заголовков, поэтому под эти запреты не попадаем; если
  // администрация попросит — источник выключается одной строкой.
  { host: 'www.hidplanet.com', kind: 'community', title: 'HIDplanet (US)', lang: 'en',
    mode: 'titles',
    // Обычный /sitemap.xml закрыт челленджем, поэтому адрес карты задан явно;
    // внутри карта ссылается на внутреннее имя vbulletin.net — правим на хост.
    sitemaps: ['https://www.hidplanet.com/core/xmlsitemap.php'],
    sitemapHostFix: true, maxUrls: 80000,
    seeds: ['https://www.hidplanet.com/'],
    // Разделы, где говорят о работе. «the-marketplace» (купля-продажа),
    // «the-off-topic-lounge» и комментарии к новостям не берём — там фактов нет.
    include: /^\/(articles\/|forum\/(general-discussion|the-hidplanet-university|showoff)\/)/i,
    delayMs: 10000, maxPages: 20000,
    note: 'html под Cloudflare (403 всем, проверено 17.09.2026) — берём только заголовки тем из карты сайта' },
];

const byHost = (host) => SOURCES.find((s) => s.host === host || s.host === `www.${host}`);
const byKind = (kind) => SOURCES.filter((s) => s.kind === kind);

module.exports = { SOURCES, byHost, byKind };
