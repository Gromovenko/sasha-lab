// Фид автозагрузки Авито (XML, formatVersion 3), категория «Предложение услуг».
// Данные — content/avito-ads.json: общие поля студии + список объявлений.
//
// Состав и значения полей выверены по официальному перечню параметров автозагрузки
// (раздел «Параметры и правила их заполнения», ветка «Автосервис», 24.09.2026) и по
// отчётам автозагрузки от 20.09 и 24.09.2026 (xlsx из кабинета).
//
// Обязательные сверх общих в этой ветке: ServiceType, ServiceSubtype,
// AutoserviceServiceType, CarServiceType, CarServiceVehicleType, Make,
// OwnSpareParts, WorkExperience, Guarantee — их отсутствие и дало «Ошибка
// параметра» ×4 в каждом объявлении 20.09.
//
// Важное отличие от старого образца: ServiceSubtype = «Автосервисы для автомобилей»
// (единственное допустимое значение по перечню); «Автосервис» из примера в образце
// — устаревшее (справочник шаблона 66870 допускает только «Автосервисы для …»).
//
// PriceList НЕ отдаём. По перечню параметров он необязательный (и в шаблоне 66870
// столбец pricelist не помечен обязательным), а ServiceName в ветке «Автосервис»
// принимается только из справочника услуг площадки: «Своя услуга» там не
// поддерживается, а справочник нам недоступен (страница шаблона отдаёт 429 и в
// веб-архиве её нет). Любое наше значение — включая «Тюнинг и оборудование»,
// которое Авито упомянуло в тексте ошибки, — даёт «Неправильно заполнен
// обязательный параметр — Услуги». Пока справочник не получен от владельца,
// необязательный параметр не шлём: черновик позиций лежит в priceListDraft.
//
// Пустые обязательные поля не выдумываем: validate() их называет, а /feed/avito.xml
// до устранения замечаний отвечает 503 — Авито не подхватит мусор.
const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, '..', 'content', 'avito-ads.json');
const MAX_IMAGES = 10;        // сверх десяти Авито игнорирует
const MAX_TITLE = 50;
const MAX_DESCRIPTION = 7500;
const MAX_ADDRESS = 256;
const MAX_MANAGER = 40;
const MAX_ID = 100;
const MAX_PRICELIST = 50;
const MAX_ADS = 50000;

// Допустимые значения (официальный перечень параметров, ветка «Автосервис»)
const ENUM = {
  serviceType: ['Автосервис, аренда'],
  serviceSubtype: ['Автосервисы для автомобилей'],
  autoserviceServiceType: ['Тюнинг и оборудование'],
  carServiceType: ['Частный автомеханик', 'Гаражный сервис', 'Сервисный центр', 'Сетевой сервисный центр', 'Официальный сервис'],
  vehicleType: ['Легковые авто', 'Грузовики и спецтехника'],
  ownSpareParts: ['Можно', 'Нет'],
  guarantee: ['Есть', 'Нет'],
  controlRepairProcess: ['Есть', 'Нет'],
  contactMethod: ['По телефону и в сообщениях', 'По телефону'],
};
const PRICE_TYPES = ['за услугу', 'за час', 'за единицу', 'за день', 'за месяц', 'за минуту',
  'за км', 'за м²', 'за м²/сутки', 'за заказ', 'за единицу/сутки', 'за нормо-час'];
const WORK_DAYS = ['пн.', 'вт.', 'ср.', 'чт.', 'пт.', 'сб.', 'вс.'];
// Id: цифры, русские и латинские буквы и символы , \ / ( ) [ ] - =
const ID_RE = /^[0-9A-Za-zА-Яа-яЁё,\\/()[\]\-= ]+$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tag = (n, v) => (v === undefined || v === null || v === '' ? '' : `<${n}>${esc(v)}</${n}>`);
const opts = (n, arr) => (arr && arr.length ? `<${n}>${arr.map((o) => `<Option>${esc(o)}</Option>`).join('')}</${n}>` : '');

function load(file = CONFIG) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

const live = (cfg) => (cfg.ads || []).filter((a) => !a.draft);
// Прайс-лист отдаём только если он явно задан в конфиге значениями из справочника
// услуг Авито. Сами ничего не подставляем — см. пояснение в шапке файла.
const priceList = (cfg, a) => (a.priceList && a.priceList.length ? a.priceList : []);
const merged = (cfg, a) => ({ ...(cfg.studio || {}).defaults, ...a });

// Требования к названию (правила Авито, раздел «Качество объявления»):
// только кириллица, без цены, без контактов, без слов капслоком и без «продам».
function titleProblems(t) {
  const bad = [];
  if (!t) return ['пустое название'];
  if (t.length > MAX_TITLE) bad.push(`название длиннее ${MAX_TITLE} знаков`);
  if (/[A-Za-z]/.test(t)) bad.push('в названии латиница — правила требуют кириллицу');
  if (/\d[\d\s.,]{2,}/.test(t)) bad.push('в названии цена — правилами запрещена');
  if (/продам/i.test(t)) bad.push('в названии слово «продам» — правилами запрещено');
  // \b в JS знает только ASCII — границу слова для кириллицы задаём явно
  if (/(^|[^\p{L}])\p{Lu}{2,}([^\p{L}]|$)/u.test(t)) bad.push('в названии слово заглавными буквами');
  return bad;
}

function enumProblem(field, value, where) {
  if (value === undefined || value === '') return null;
  return ENUM[field].includes(value) ? null : `${where}: ${field}="${value}" — нет в справочнике Авито (${ENUM[field].join(' / ')})`;
}

function validate(cfg) {
  const bad = [];
  const s = cfg.studio || {};
  if (!s.address) bad.push('studio.address: нет адреса студии');
  else if (s.address.length > MAX_ADDRESS) bad.push(`studio.address: длиннее ${MAX_ADDRESS} знаков`);
  if (!s.imageBase) bad.push('studio.imageBase: нет базового адреса фото');
  if (s.managerName && s.managerName.length > MAX_MANAGER) bad.push(`studio.managerName: длиннее ${MAX_MANAGER} знаков`);
  const cm = enumProblem('contactMethod', s.contactMethod, 'studio.contactMethod');
  if (cm) bad.push(cm);
  (s.workDays || []).forEach((d) => { if (!WORK_DAYS.includes(d)) bad.push(`studio.workDays: «${d}» — допустимы ${WORK_DAYS.join(' ')}`); });
  for (const f of ['workTimeFrom', 'workTimeTo']) {
    if (s[f] && !TIME_RE.test(s[f])) bad.push(`studio.${f}: время в формате ЧЧ:ММ`);
  }
  if (live(cfg).length > MAX_ADS) bad.push(`ads: больше ${MAX_ADS} объявлений в файле`);
  const ids = new Set();
  live(cfg).forEach((a, i) => {
    const w = `ads[${i}] ${a.id || '?'}`;
    const d = merged(cfg, a);
    if (!a.id) bad.push(`${w}: нет Id`);
    else {
      if (ids.has(a.id)) bad.push(`${w}: повтор Id`);
      if (String(a.id).length > MAX_ID) bad.push(`${w}: Id длиннее ${MAX_ID} знаков`);
      if (!ID_RE.test(String(a.id))) bad.push(`${w}: в Id недопустимые символы`);
      ids.add(a.id);
    }
    titleProblems(a.title).forEach((p) => bad.push(`${w}: ${p}`));
    if (!a.description || a.description.length < 200) bad.push(`${w}: описание короче 200 знаков`);
    else if (a.description.length > MAX_DESCRIPTION) bad.push(`${w}: описание длиннее ${MAX_DESCRIPTION} знаков`);
    if (/https?:\/\//i.test(a.description || '')) bad.push(`${w}: в описании ссылка — правилами запрещена`);
    if (/(\+7|\b8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/.test(a.description || '')) bad.push(`${w}: в описании телефон — правилами запрещён`);
    if (/[\w.-]+@[\w.-]+\.[a-z]{2,}/i.test(a.description || '')) bad.push(`${w}: в описании адрес почты — правилами запрещён`);
    const pl = priceList(cfg, a);
    if (pl.length > MAX_PRICELIST) bad.push(`${w}: в прайс-листе больше ${MAX_PRICELIST} услуг`);
    pl.forEach((p, j) => {
      if (!p.name) bad.push(`${w}: прайс-лист, позиция ${j + 1}: нет названия услуги`);
      if (p.name === 'Своя услуга') bad.push(`${w}: прайс-лист: «Своя услуга» в категории «Автосервис» не поддерживается`);
      if (!Number.isInteger(Number(p.price)) || Number(p.price) <= 0) bad.push(`${w}: прайс-лист «${p.name}»: цена должна быть целым числом рублей`);
      if (p.type && !PRICE_TYPES.includes(p.type)) bad.push(`${w}: прайс-лист «${p.name}»: тип стоимости «${p.type}» — нет в справочнике`);
    });
    if (!Number.isInteger(Number(a.price)) || Number(a.price) <= 0) bad.push(`${w}: цена должна быть целым числом рублей`);
    if (!a.images || !a.images.length) bad.push(`${w}: нет фото`);
    else if (a.images.length > MAX_IMAGES) bad.push(`${w}: больше ${MAX_IMAGES} фото`);
    // обязательные параметры ветки «Автосервис»
    if (!d.guarantee) bad.push(`${w}: не задана Гарантия (Guarantee)`);
    if (!(Number(d.workExperience) > 0) || !Number.isInteger(Number(d.workExperience))) bad.push(`${w}: Опыт работы (WorkExperience) — целое число лет`);
    if (!d.make || !d.make.length) bad.push(`${w}: не заданы Марки авто (Make)`);
    if (!d.ownSpareParts) bad.push(`${w}: не задано «Можно со своими запчастями» (OwnSpareParts)`);
    if (!d.carServiceType) bad.push(`${w}: не задан Тип сервиса (CarServiceType)`);
    if (!d.vehicleType) bad.push(`${w}: не задан Тип техники (CarServiceVehicleType)`);
    for (const f of ['serviceType', 'serviceSubtype', 'autoserviceServiceType', 'carServiceType', 'vehicleType', 'ownSpareParts', 'guarantee', 'controlRepairProcess']) {
      const p = enumProblem(f, d[f], w);
      if (p) bad.push(p);
    }
  });
  if (!live(cfg).length) bad.push('ads: пустой список объявлений');
  return bad;
}

function adXml(a, s, cfg) {
  const d = merged(cfg, a);
  const imgs = (a.images || []).slice(0, MAX_IMAGES)
    .map((f) => `<Image url="${esc(/^https?:/.test(f) ? f : s.imageBase.replace(/\/$/, '') + '/' + f)}"/>`).join('');
  const prices = priceList(cfg, a).slice(0, MAX_PRICELIST)
    .map((p) => `<Service>${tag('ServiceName', p.name)}${tag('ServicePrice', p.price)}${p.from ? '<ServiceStartingPrice>Да</ServiceStartingPrice>' : ''}${tag('ServicePriceType', p.type || 'за услугу')}</Service>`).join('');
  return `<Ad>${tag('Id', a.id)}${tag('Address', s.address)}<Category>Предложение услуг</Category>` +
    `${tag('ServiceType', d.serviceType || 'Автосервис, аренда')}${tag('ServiceSubtype', d.serviceSubtype || 'Автосервисы для автомобилей')}` +
    `${tag('AutoserviceServiceType', d.autoserviceServiceType || 'Тюнинг и оборудование')}` +
    `${tag('CarServiceType', d.carServiceType)}${tag('CarServiceVehicleType', d.vehicleType)}` +
    `${tag('Title', a.title)}${tag('Description', a.description)}` +
    `${opts('Make', d.make)}${tag('OwnSpareParts', d.ownSpareParts)}${tag('Guarantee', d.guarantee)}${tag('WorkExperience', d.workExperience)}` +
    `${tag('ControlRepairProcess', d.controlRepairProcess)}${opts('Extra', d.extra)}` +
    `${opts('WorkDays', s.workDays)}${tag('WorkTimeFrom', s.workTimeFrom)}${tag('WorkTimeTo', s.workTimeTo)}` +
    `${opts('ContactDays', s.contactDays || s.workDays)}${tag('ContactTimeFrom', s.contactTimeFrom)}${tag('ContactTimeTo', s.contactTimeTo)}` +
    `${prices ? `<PriceList>${prices}</PriceList>` : ''}${tag('Price', a.price)}${tag('ManagerName', s.managerName)}` +
    `${tag('ContactPhone', s.phone)}${tag('ContactMethod', s.contactMethod)}<AdStatus>Free</AdStatus><Images>${imgs}</Images></Ad>`;
}

function build(cfg = load()) {
  const s = cfg.studio || {};
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Ads target="Avito.ru" formatVersion="3">\n${live(cfg).map((a) => adXml(a, s, cfg)).join('\n')}\n</Ads>\n`;
}

module.exports = { load, validate, build, titleProblems, MAX_IMAGES, ENUM, PRICE_TYPES };

if (require.main === module) {
  const cfg = load();
  const bad = validate(cfg);
  if (bad.length) {
    console.error('Фид не готов:\n - ' + bad.join('\n - '));
    if (!process.argv.includes('--force')) process.exit(1);
  }
  process.stdout.write(build(cfg));
}
