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

// Паузы delayMs ниже — не «на глаз», а замер 19.09.2026 с сервера проекта
// (`node harvest/run.js probe`, лесенка 4000 → 300 мс на каждом источнике).
// Почти везде получилось 1000 мс — пол вежливости, ниже которого замер не
// опускается ни при каком результате, хотя сами площадки держали и 300 мс.
// Три исключения названы самими площадками в robots.txt: bi-vision.ru
// Crawl-delay 40, nts-auto.com — 20, hidplanet.com — 10 секунд.
const SOURCES = [
  // ── этап 1: примеры работ ────────────────────────────────────────────────
  { host: 'www.xenonshop.ru', kind: 'works', title: 'Xenonshop',
    seeds: ['https://www.xenonshop.ru/'],
    // Карта сайта печатает адреса БЕЗ www (xenonshop.ru, не www.xenonshop.ru).
    // Без sitemapHostFix это расхождение хостов роняло ВСЕ записи карты на этапе
    // fix() в crawl.js — источник молча полз только обходом по ссылкам (walk),
    // sitemap.xml по факту не читался ни разу (обнаружено 18.09.2026: «listed=0»).
    sitemapHostFix: true,
    include: /\/(blog|stati|articles|nashi-raboty|works|catalog)\//i, delayMs: 1000, maxPages: 3000 },
  { host: 'www.galogenu.net', kind: 'works', title: 'Галогену.нет',
    seeds: ['https://www.galogenu.net/'],
    include: /\/(blog|stati|articles|works|raboty|catalog)\//i, delayMs: 1000, maxPages: 3600 },
  { host: 'autosvet.pro', kind: 'works', title: 'Autosvet.pro',
    seeds: ['https://autosvet.pro/'], include: /./, delayMs: 1000, maxPages: 600 },
  { host: 'hltuning.ru', kind: 'works', title: 'HL Tuning',
    seeds: ['https://hltuning.ru/'],
    // robots этого сайта запрещает /tpost/ и /catalog/ — загрузчик их и не возьмёт,
    // здесь фильтр только сужает область до осмысленного.
    include: /./, delayMs: 1000, maxPages: 1000 },

  // ── этап 2: комплектующие ────────────────────────────────────────────────
  { host: 'luxsar.ru', kind: 'parts', title: 'Luxsar',
    seeds: ['https://luxsar.ru/'], include: /./, delayMs: 1000, maxPages: 7500 },
  { host: 'legal-xenon.ru', kind: 'parts', title: 'Legal Xenon',
    seeds: ['https://legal-xenon.ru/'], include: /./, delayMs: 1000, maxPages: 3600 },
  { host: 'vdf-light.ru', kind: 'parts', title: 'VDF Light',
    seeds: ['https://vdf-light.ru/'], include: /./,
    // Заход 18.09 на 400 стр. упёрся в 429 (Too Many Requests) на /catalog/ —
    // проверено вручную curl'ом: root «/» отдаёт 200, а /catalog/* стабильно 429
    // ещё 2,5 ч после захода. Это не таймаут и не наш баг, а лимитер площадки
    // именно на раздел каталога. 19.09.2026 замер (harvest/probe.js) прошёл всю
    // лесенку до 300 мс без единого 429 — лимитер накопительный, мгновенную
    // нагрузку он не видит. Поэтому пауза здесь 1000 мс, как у всех, а защитой
    // работает штраф в загрузчике: первый же 429 удваивает паузу до конца захода
    // (см. sasha-lab-harvest-vdf-ratelimit.md и harvest/http.js).
    delayMs: 1000, maxPages: 8600 },
  { host: 'www.criline.ru', kind: 'parts', title: 'Criline',
    seeds: ['https://www.criline.ru/'], include: /./, delayMs: 1000, maxPages: 10100 },
  { host: 'steklafar.ru', kind: 'parts', title: 'Стёкла фар',
    seeds: ['https://steklafar.ru/'], include: /./, delayMs: 1000, maxPages: 1500 },
  { host: 'aozoom-light.ru', kind: 'parts', title: 'AOZOOM Light',
    // Официальный каталог бренда AOZOOM (линзы для би-led/би-ксенон): ~10,7 тыс.
    // товаров в трёх файлах sitemap-products-N.xml + 197 страниц/постов
    // в sitemap-pages.xml. robots.txt (проверено 18.09.2026) разрешает всё,
    // кроме корзины/сортировок/тегов — сбор ничего из этого не трогает.
    seeds: ['https://aozoom-light.ru/'], include: /./, delayMs: 1000, maxPages: 11000 },
  { host: 'nts-auto.com', kind: 'parts', title: 'NTS-Auto',
    // Crawl-delay: 20 в robots.txt (замер 19.09.2026) — лесенку пауз здесь даже
    // не запускаем, площадка сама назвала свою цену. Полный заход ~17 часов.
    seeds: ['https://nts-auto.com/'], include: /./, delayMs: 20000, maxPages: 3100 },
  { host: 'mtflight-shop.com', kind: 'parts', title: 'MTFlight Shop',
    seeds: ['https://mtflight-shop.com/'], include: /./, delayMs: 1000, maxPages: 1400 },
  { host: 'tuningfar.com', kind: 'parts', title: 'TuningFar',
    seeds: ['https://tuningfar.com/'], include: /./, delayMs: 1000, maxPages: 3700 },
  { host: 'bi-vision.ru', kind: 'parts', title: 'Bi-Vision',
    // robots.txt площадки прямо задаёт Crawl-delay: 40 — разбор robots режет это
    // поле потолком в 30 с, поэтому настоящее значение продублировано здесь:
    // delayMs для сбора и robotsDelayHint для замера скорости (harvest/probe.js),
    // чтобы замер не «разогнал» источник до разрешённых загрузчиком 30 с.
    seeds: ['https://bi-vision.ru/'], include: /./, delayMs: 40000,
    robotsDelayHint: 40000, maxPages: 3300 },
  { host: 'dixel.store', kind: 'parts', title: 'Dixel',
    // Обычный /sitemap.xml и /sitemap_index.xml пустые — реальная карта у площадки
    // отдаётся по параметрическому адресу из robots.txt (route=feed/google_sitemap).
    // Там же own robots.txt закрывает почти все карточки товара
    // (Disallow: /catalog и /index.php?route=product* — для * и для Yandex одинаково,
    // проверено 18.09.2026), так что реальный сбор здесь будет заметно меньше
    // 4,8 тыс. адресов из карты — это не баг, загрузчик просто уважает запрет площадки.
    seeds: ['https://dixel.store/'],
    sitemaps: ['https://dixel.store/index.php?route=feed/google_sitemap'],
    include: /./, delayMs: 1000, maxPages: 4800 },
  { host: 'viper-auto.ru', kind: 'parts', title: 'Viper',
    // Бренд Viper (модули/линзы) — конкурент на Авито использует его в объявлениях.
    // Карта сайта ~380 адресов (282 /catalog/, 68 /download-center/), в ней http://
    // при сайте на https — тот же хост, разбор карты это переносит. robots.txt
    // (замер 20.09.2026): закрыты только ?d=*, /f/, /fm/, /tmp/; Crawl-delay нет.
    seeds: ['https://viper-auto.ru/'], include: /./, delayMs: 1500, maxPages: 450 },
  { host: 'statlight.ru', kind: 'parts', title: 'Statlight',
    seeds: ['https://statlight.ru/'], include: /./, delayMs: 1000, maxPages: 2650 },
  { host: 'optima-light.ru', kind: 'parts', title: 'Optima-Light',
    seeds: ['https://optima-light.ru/'], include: /./, delayMs: 1000, maxPages: 3450 },
  { host: 'electro-kot.ru', kind: 'parts', title: 'Electro-Kot',
    // Самый крупный источник из новой партии — ~30 тыс. адресов в карте, но не
    // «всякая автоэлектрика»: основная масса — это готовые страницы вида
    // «<марка+модель+год> — <ближний/дальний свет | повороты | птф>», то есть
    // уже сама структура сайта — данные о посадке ламп/линз по моделям, ровно
    // то, что нужно для /baza/avto/. Полный обход при прежних 4000 мс занимал бы
    // ~33 часа; по замеру 19.09.2026 источник отвечает за 340 мс и спокойно
    // держит запрос в секунду — те же 30 тысяч адресов это ~11 часов.
    seeds: ['https://electro-kot.ru/'], include: /./, delayMs: 1000, maxPages: 30000 },

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

// ── измеренная пауза перекрывает записанную ────────────────────────────────
// Числа delayMs выше — это то, с чего источник начинает жизнь в реестре:
// осторожная оценка руками. Настоящее значение даёт замер
// (`node harvest/run.js probe` → seo/data/harvest-speed.json): он ходит к
// источнику лесенкой пауз и смотрит, где тот начинает отказывать. Если замер
// есть и он свежий — работаем по нему, иначе по записанному здесь.
//
// Три предохранителя, без которых такой перехват опасен:
//   * замер старше 30 дней не берём — чужой сайт мог сменить хостинг и лимиты;
//   * пауза быстрее секунды не принимается ни при каком замере (пол вежливости
//     живёт в probe.js, здесь он продублирован как проверка на входе);
//   * файл плана читается «мягко»: нет, битый, чужой формат — просто работаем
//     по записанному, а не роняем сбор.
const SPEED_PLAN = process.env.HARVEST_SPEED_PLAN
  || require('path').join(__dirname, '..', 'seo', 'data', 'harvest-speed.json');
const PLAN_MAX_AGE_DAYS = 30;
const PLAN_MIN_DELAY = 1000;

function applySpeedPlan(list, file = SPEED_PLAN) {
  let doc;
  try { doc = JSON.parse(require('fs').readFileSync(file, 'utf8')); } catch { return list; }
  const ageDays = (Date.now() - Date.parse(doc.measuredAt || 0)) / 86400000;
  if (!(ageDays >= 0) || ageDays > PLAN_MAX_AGE_DAYS) return list;
  for (const row of doc.plan || []) {
    const src = list.find((s) => s.host === row.host);
    if (!src || !(row.recommend >= PLAN_MIN_DELAY)) continue;
    src.measuredMs = row.recommend;
    src.delayMs = row.recommend;
  }
  return list;
}

applySpeedPlan(SOURCES);

const byHost = (host) => SOURCES.find((s) => s.host === host || s.host === `www.${host}`);
const byKind = (kind) => SOURCES.filter((s) => s.kind === kind);

module.exports = { SOURCES, byHost, byKind, applySpeedPlan, PLAN_MIN_DELAY, PLAN_MAX_AGE_DAYS };
