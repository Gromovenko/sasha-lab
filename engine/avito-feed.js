// Фид автозагрузки Авито (XML, formatVersion 3), категория «Предложение услуг».
// Данные — content/avito-ads.json: общие поля студии + список объявлений. Пустые
// обязательные поля (адрес, цена, фото) не выдумываем: validate() их называет,
// а /feed/avito.xml до устранения замечаний отвечает 503 — Авито не подхватит мусор.
const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, '..', 'content', 'avito-ads.json');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tag = (n, v) => (v === undefined || v === null || v === '' ? '' : `<${n}>${esc(v)}</${n}>`);
const opts = (n, arr) => (arr && arr.length ? `<${n}>${arr.map((o) => `<Option>${esc(o)}</Option>`).join('')}</${n}>` : '');

function load(file = CONFIG) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function validate(cfg) {
  const bad = [];
  const s = cfg.studio || {};
  if (!s.address) bad.push('studio.address: нет адреса студии');
  if (!s.imageBase) bad.push('studio.imageBase: нет базового адреса фото');
  const ids = new Set();
  (cfg.ads || []).forEach((a, i) => {
    const w = `ads[${i}] ${a.id || '?'}`;
    if (!a.id) bad.push(`${w}: нет Id`);
    else if (ids.has(a.id)) bad.push(`${w}: повтор Id`);
    ids.add(a.id);
    if (!a.title || a.title.length > 50) bad.push(`${w}: заголовок пуст или длиннее 50 знаков`);
    if (!a.description || a.description.length < 200) bad.push(`${w}: описание короче 200 знаков`);
    if (!(Number(a.price) > 0)) bad.push(`${w}: не задана цена`);
    if (!a.images || !a.images.length) bad.push(`${w}: нет фото`);
  });
  if (!(cfg.ads || []).length) bad.push('ads: пустой список объявлений');
  return bad;
}

function adXml(a, s) {
  const d = { ...s.defaults, ...a };
  const imgs = (a.images || []).map((f) => `<Image url="${esc(/^https?:/.test(f) ? f : s.imageBase.replace(/\/$/, '') + '/' + f)}"/>`).join('');
  const prices = (a.priceList || []).map((p) => `<Service>${tag('ServiceName', p.name)}${tag('ServicePrice', p.price)}${p.from ? '<ServiceStartingPrice>Да</ServiceStartingPrice>' : ''}${tag('ServicePriceType', p.type || 'за услугу')}</Service>`).join('');
  return `<Ad>${tag('Id', a.id)}${tag('Address', s.address)}<Category>Предложение услуг</Category>` +
    `${tag('ServiceType', d.serviceType || 'Транспорт, перевозки')}${tag('Title', a.title)}${tag('Description', a.description)}` +
    `${tag('ServiceSubtype', d.serviceSubtype || 'Автосервис')}${tag('AutoserviceServiceType', d.autoserviceServiceType || 'Тюнинг и оборудование')}` +
    `${tag('CarServiceType', d.carServiceType || 'Сервисный центр')}${tag('CarServiceVehicleType', d.vehicleType || 'Легковые авто')}` +
    `${opts('Make', d.make)}${tag('Guarantee', d.guarantee)}${tag('WorkExperience', d.workExperience)}` +
    `${opts('WorkDays', s.workDays)}${tag('WorkTimeFrom', s.workTimeFrom)}${tag('WorkTimeTo', s.workTimeTo)}` +
    `${opts('ContactDays', s.workDays)}${tag('ContactTimeFrom', s.workTimeFrom)}${tag('ContactTimeTo', s.workTimeTo)}` +
    `${prices ? `<PriceList>${prices}</PriceList>` : ''}${tag('Price', a.price)}${tag('ManagerName', s.managerName)}` +
    `${tag('ContactPhone', s.phone)}<AllowEmail>Да</AllowEmail><AdStatus>Free</AdStatus><Images>${imgs}</Images></Ad>`;
}

function build(cfg = load()) {
  const s = cfg.studio || {};
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Ads target="Avito.ru" formatVersion="3">\n${(cfg.ads || []).map((a) => adXml(a, s)).join('\n')}\n</Ads>\n`;
}

module.exports = { load, validate, build };

if (require.main === module) {
  const cfg = load();
  const bad = validate(cfg);
  if (bad.length) {
    console.error('Фид не готов:\n - ' + bad.join('\n - '));
    if (!process.argv.includes('--force')) process.exit(1);
  }
  process.stdout.write(build(cfg));
}
