// Фид автозагрузки Авито (XML, formatVersion 3), категория «Предложение услуг».
// Данные — content/avito-ads.json: общие поля студии + список объявлений.
//
// Состав полей выверен по отчёту автозагрузки от 20.09.2026 (xlsx из кабинета):
// в ветке «Автосервис, аренда → Автосервис → Тюнинг и оборудование» Авито считает
// ОБЯЗАТЕЛЬНЫМИ четыре параметра сверх общих — Guarantee, WorkExperience, Make,
// OwnSpareParts. Их отсутствие и дало «Ошибка параметра» ×4 в каждом объявлении.
// ServiceType берётся из справочника того же файла (лист «Спр-…»): «Автосервис,
// аренда»; значения «Транспорт, перевозки» из старого образца в справочнике нет.
//
// Пустые обязательные поля не выдумываем: validate() их называет, а /feed/avito.xml
// до устранения замечаний отвечает 503 — Авито не подхватит мусор.
const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, '..', 'content', 'avito-ads.json');
const MAX_IMAGES = 10;      // сверх десяти Авито игнорирует
const MAX_TITLE = 50;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tag = (n, v) => (v === undefined || v === null || v === '' ? '' : `<${n}>${esc(v)}</${n}>`);
const opts = (n, arr) => (arr && arr.length ? `<${n}>${arr.map((o) => `<Option>${esc(o)}</Option>`).join('')}</${n}>` : '');

function load(file = CONFIG) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

const live = (cfg) => (cfg.ads || []).filter((a) => !a.draft);
const merged = (cfg, a) => ({ ...(cfg.studio || {}).defaults, ...a });

// Требования к названию (правила Авито, раздел «Качество объявления»):
// только кириллица, без цены и без слов капслоком.
function titleProblems(t) {
  const bad = [];
  if (!t) return ['пустое название'];
  if (t.length > MAX_TITLE) bad.push(`название длиннее ${MAX_TITLE} знаков`);
  if (/[A-Za-z]/.test(t)) bad.push('в названии латиница — правила требуют кириллицу');
  if (/\d[\d\s.,]{2,}/.test(t)) bad.push('в названии цена — правилами запрещена');
  // \b в JS знает только ASCII — границу слова для кириллицы задаём явно
  if (/(^|[^\p{L}])\p{Lu}{2,}([^\p{L}]|$)/u.test(t)) bad.push('в названии слово заглавными буквами');
  return bad;
}

function validate(cfg) {
  const bad = [];
  const s = cfg.studio || {};
  if (!s.address) bad.push('studio.address: нет адреса студии');
  if (!s.imageBase) bad.push('studio.imageBase: нет базового адреса фото');
  const ids = new Set();
  live(cfg).forEach((a, i) => {
    const w = `ads[${i}] ${a.id || '?'}`;
    const d = merged(cfg, a);
    if (!a.id) bad.push(`${w}: нет Id`);
    else if (ids.has(a.id)) bad.push(`${w}: повтор Id`);
    ids.add(a.id);
    titleProblems(a.title).forEach((p) => bad.push(`${w}: ${p}`));
    if (!a.description || a.description.length < 200) bad.push(`${w}: описание короче 200 знаков`);
    if (/https?:\/\//i.test(a.description || '')) bad.push(`${w}: в описании ссылка — правилами запрещена`);
    if (/(\+7|\b8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/.test(a.description || '')) bad.push(`${w}: в описании телефон — правилами запрещён`);
    if (/[\w.-]+@[\w.-]+\.[a-z]{2,}/i.test(a.description || '')) bad.push(`${w}: в описании адрес почты — правилами запрещён`);
    (a.priceList || []).forEach((s2, j) => {
      if (!s2.name) bad.push(`${w}: прайс-лист, позиция ${j + 1}: нет названия услуги`);
      if (!Number.isInteger(Number(s2.price)) || Number(s2.price) <= 0) bad.push(`${w}: прайс-лист «${s2.name}»: цена должна быть целым числом рублей`);
    });
    if (!Number.isInteger(Number(a.price)) || Number(a.price) <= 0) bad.push(`${w}: цена должна быть целым числом рублей`);
    if (!a.images || !a.images.length) bad.push(`${w}: нет фото`);
    else if (a.images.length > MAX_IMAGES) bad.push(`${w}: больше ${MAX_IMAGES} фото`);
    // обязательные параметры ветки «Автосервис» (отчёт автозагрузки 20.09.2026)
    if (!d.guarantee) bad.push(`${w}: не задана Гарантия (Guarantee)`);
    if (!(Number(d.workExperience) > 0)) bad.push(`${w}: не задан Опыт работы (WorkExperience), лет`);
    if (!d.make || !d.make.length) bad.push(`${w}: не заданы Марки авто (Make)`);
    if (!d.ownSpareParts) bad.push(`${w}: не задано «Можно со своими запчастями» (OwnSpareParts)`);
    if (!d.carServiceType) bad.push(`${w}: не задан Тип сервиса (CarServiceType)`);
    if (!d.vehicleType) bad.push(`${w}: не задан Тип техники (CarServiceVehicleType)`);
  });
  if (!live(cfg).length) bad.push('ads: пустой список объявлений');
  return bad;
}

function adXml(a, s, cfg) {
  const d = merged(cfg, a);
  const imgs = (a.images || []).slice(0, MAX_IMAGES)
    .map((f) => `<Image url="${esc(/^https?:/.test(f) ? f : s.imageBase.replace(/\/$/, '') + '/' + f)}"/>`).join('');
  const prices = (a.priceList || []).map((p) => `<Service>${tag('ServiceName', p.name)}${tag('ServicePrice', p.price)}${p.from ? '<ServiceStartingPrice>Да</ServiceStartingPrice>' : ''}${tag('ServicePriceType', p.type || 'за услугу')}</Service>`).join('');
  return `<Ad>${tag('Id', a.id)}${tag('Address', s.address)}<Category>Предложение услуг</Category>` +
    `${tag('ServiceType', d.serviceType || 'Автосервис, аренда')}${tag('ServiceSubtype', d.serviceSubtype || 'Автосервис')}` +
    `${tag('AutoserviceServiceType', d.autoserviceServiceType || 'Тюнинг и оборудование')}` +
    `${tag('CarServiceType', d.carServiceType)}${tag('CarServiceVehicleType', d.vehicleType)}` +
    `${tag('Title', a.title)}${tag('Description', a.description)}` +
    `${opts('Make', d.make)}${tag('OwnSpareParts', d.ownSpareParts)}${tag('Guarantee', d.guarantee)}${tag('WorkExperience', d.workExperience)}` +
    `${tag('ControlRepairProcess', d.controlRepairProcess)}${tag('Extra', d.extra)}` +
    `${opts('WorkDays', s.workDays)}${tag('WorkTimeFrom', s.workTimeFrom)}${tag('WorkTimeTo', s.workTimeTo)}` +
    `${opts('ContactDays', s.workDays)}${tag('ContactTimeFrom', s.workTimeFrom)}${tag('ContactTimeTo', s.workTimeTo)}` +
    `${prices ? `<PriceList>${prices}</PriceList>` : ''}${tag('Price', a.price)}${tag('ManagerName', s.managerName)}` +
    `${tag('ContactPhone', s.phone)}<AdStatus>Free</AdStatus><Images>${imgs}</Images></Ad>`;
}

function build(cfg = load()) {
  const s = cfg.studio || {};
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Ads target="Avito.ru" formatVersion="3">\n${live(cfg).map((a) => adXml(a, s, cfg)).join('\n')}\n</Ads>\n`;
}

module.exports = { load, validate, build, titleProblems, MAX_IMAGES };

if (require.main === module) {
  const cfg = load();
  const bad = validate(cfg);
  if (bad.length) {
    console.error('Фид не готов:\n - ' + bad.join('\n - '));
    if (!process.argv.includes('--force')) process.exit(1);
  }
  process.stdout.write(build(cfg));
}
