// Отраслевой пакет — единственное место, где движок узнаёт про конкретный бизнес.
//
// Пакет описывает ДАННЫМИ: какие поля у объекта заявки, что спрашивать, что
// искать на фото, чем торгуем, какие правила меняют расчёт и как выглядит КП.
// Код (rules/quote/offer/pipeline) про линзы и фары не знает ничего — поэтому
// тот же движок обслуживает подбор отеля (packs/hotels.json) без единой правки.
//
// Пакет — ФАЙЛ в git, а не запись в базе: это конфигурация бизнеса, её правят
// ревью и откатывают коммитом. Живые цены — исключение, они уезжают в таблицу
// catalog (мастер меняет их из панели), файл только наливает эталон.
const fs = require('fs');
const path = require('path');

const DIR = process.env.PACKS_DIR || path.join(__dirname, '..', 'packs');
const DEFAULT_ID = process.env.PACK || 'avtosvet';
const cache = new Map();

function list() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
}

function read(id) {
  const file = path.join(DIR, `${String(id).replace(/[^\w-]/g, '')}.json`);
  if (!fs.existsSync(file)) throw new Error(`нет отраслевого пакета «${id}» (${file})`);
  return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function load(id = DEFAULT_ID) {
  if (!cache.has(id)) {
    const p = read(id);
    const errors = validate(p);
    // Битый пакет не подсовываем движку молча: расчёт по нему даст цену «0 ₽»
    // или ссылку на несуществующую позицию, а увидит это клиент.
    if (errors.length) throw new Error(`пакет «${id}» не прошёл проверку: ${errors.join('; ')}`);
    cache.set(id, p);
  }
  return cache.get(id);
}

function reload(id) { cache.delete(id); return load(id); }

// Значения по умолчанию, чтобы остальному коду не приходилось писать `|| []`.
function normalize(p) {
  const pack = { ...p };
  pack.currency = pack.currency || 'RUB';
  pack.brand = pack.brand || {};
  pack.subject = pack.subject || { label: 'Объект', fields: [] };
  pack.subject.fields = pack.subject.fields || [];
  pack.wants = pack.wants || [];
  pack.photos = pack.photos || { min: 0, checklist: [] };
  pack.photos.checklist = pack.photos.checklist || [];
  pack.vision = pack.vision || { instruction: '', findings: [] };
  pack.vision.findings = pack.vision.findings || [];
  pack.catalog = (pack.catalog || []).map((i, n) => ({
    kind: 'item', unit: '', tags: [], includes: [], enabled: true, sort: 100 + n, ...i,
    price: Number(i.price || 0),
  }));
  pack.rules = pack.rules || [];
  pack.offer = pack.offer || {};
  pack.offer.maxChoices = Number(pack.offer.maxChoices || 2);
  pack.offer.defaultTags = pack.offer.defaultTags || [];
  pack.followups = pack.followups || [];
  pack.knowledge = pack.knowledge || {};
  return pack;
}

// Проверка пакета — отдельная функция, её же гоняет `node engine/cli.js packs`
// и тест: опечатка в sku правила всплывает на сборке, а не на живом клиенте.
function validate(pack) {
  const e = [];
  if (!pack.id) e.push('нет id');
  if (!pack.title) e.push('нет title');
  if (!pack.subject.fields.length) e.push('пустой subject.fields');
  for (const f of pack.subject.fields) if (!f.key) e.push('поле subject без key');

  const skus = new Set();
  for (const i of pack.catalog) {
    if (!i.sku) { e.push('позиция каталога без sku'); continue; }
    if (skus.has(i.sku)) e.push(`дубль sku ${i.sku}`);
    skus.add(i.sku);
    if (!i.title) e.push(`позиция ${i.sku} без названия`);
    if (!Number.isFinite(i.price)) e.push(`позиция ${i.sku}: цена не число`);
  }
  if (!pack.catalog.some((i) => i.kind === 'item' && i.enabled)) e.push('в каталоге нет ни одной основной позиции (kind=item)');

  const checkThen = (then, where) => {
    if (!then) return;
    for (const sku of [].concat(then.addItem || [])) {
      if (!skus.has(sku)) e.push(`${where}: addItem ссылается на несуществующий sku ${sku}`);
    }
    for (const t of [].concat(then.requireTags || [])) {
      if (!pack.catalog.some((i) => (i.tags || []).includes(t))) e.push(`${where}: requireTags «${t}» не встречается ни у одной позиции`);
    }
  };
  for (const r of pack.rules) {
    if (!r.id) e.push('правило без id');
    if (!r.when) e.push(`правило ${r.id || '?'} без when`);
    checkThen(r.then, `правило ${r.id || '?'}`);
  }
  const codes = new Set();
  for (const f of pack.vision.findings) {
    if (!f.code) { e.push('находка зрения без code'); continue; }
    if (codes.has(f.code)) e.push(`дубль кода находки ${f.code}`);
    codes.add(f.code);
    checkThen(f.then, `находка ${f.code}`);
  }
  if (!pack.offer.template) e.push('нет offer.template');
  const steps = new Set();
  for (const f of pack.followups) {
    if (steps.has(f.step)) e.push(`дубль шага догоняющего касания ${f.step}`);
    steps.add(f.step);
    if (!f.text) e.push(`догоняющее касание ${f.step} без текста`);
    if (!Number.isFinite(Number(f.afterHours))) e.push(`догоняющее касание ${f.step}: afterHours не число`);
  }
  return e;
}

const findingCodes = (pack) => pack.vision.findings.map((f) => f.code);
const itemBySku = (pack, sku) => pack.catalog.find((i) => i.sku === sku) || null;

module.exports = { DIR, DEFAULT_ID, list, load, reload, read, validate, normalize, findingCodes, itemBySku };
