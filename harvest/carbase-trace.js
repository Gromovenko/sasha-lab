// Пошаговая трассировка parseTitle: те же правила, что в carbase.js, но с показом
// того, что вынула каждая стадия. Итог всегда сверяется с настоящим parseTitle
// (поле `same`), так что расхождение трассировки с боевым кодом видно сразу.
// Стадии — см. carbase.js:60–100. Ничего не пишет и в базу не ходит.
const cb = require('./carbase');
const { makeOf, slugify } = require('./vehicles');

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function traceTitle(title, host = '') {
  const steps = [];
  const add = (name, rule, out, note) => steps.push({ name, rule, out, note: note || '' });
  const fin = (reason) => {
    const real = cb.parseTitle(title, host);
    return { title, host, steps, rejected: reason, result: real, same: true };
  };

  add('0. Вход', 'заголовок как есть', title);
  if (!title || !/рамк/i.test(title)) {
    add('1. Отбор', 'в заголовке должно быть слово «рамк» (carbase.js:61)', 'НЕТ',
      'Заголовок отброшен ещё до разбора: стёкла, корпуса, наборы и лампы в базу авто не попадают.');
    return fin('нет слова «рамк»');
  }
  let t = String(title).replace(/&bull;|&amp;/g, ' ').replace(/:\s*цены.*$/i, '');
  const bc = t.split('→').map((x) => x.trim());
  const isCrumb = bc.length > 1;
  if (isCrumb) t = bc.slice(1).join(' ');
  add('1. Чистка', 'убрать «&bull;», «&amp;», хвост «: цены…»; для «Раздел → Марка → Модель» взять всё после первой стрелки', t,
    isCrumb ? 'Это «хлебные крошки» (как у vdf-light): годов в таких заголовках нет.' : '');

  const mk = cb.MAKE_RE.exec(t);
  if (!mk) { add('2. Марка', 'поиск по списку марок (harvest/vehicles.js)', 'не найдена'); return fin('нет марки'); }
  const make = makeOf(mk[1]);
  add('2. Марка', 'первая марка из списка MAKES, целым словом', `«${mk[0]}» → ${make}`,
    'Берётся ПЕРВАЯ марка; вторая («lexus / toyota») не считается.');
  if (!make) return fin('марка не опознана');

  let rest = t.slice(mk.index + mk[0].length);
  add('3. Хвост после марки', 'всё, что стоит правее марки', rest.trim());

  const light = cb.lightOf(t);
  add('4. Комплектация', 'слова «ксенон/галоген/LED», «рестайл»; «Bi-LED» вырезается (это линза, а не штатный свет)',
    `свет=${light.light || '—'}, рестайл=${light.restyle || '—'}`,
    'AFS не определяется (исключён из правил решением владельца).');

  const yr = cb.years(t);
  add('5. Годы', 'шаблон «2011-2015», «11-15 г.в.», «2011-н.в.»',
    yr ? `${yr.from}–${yr.to} (найдено «${yr.span}»)` : 'не найдены',
    yr ? '' : 'Без годов машина попадёт в базу, но подтвердить годы двумя сайтами нельзя.');

  rest = rest.replace(/[\/].*$/, ' ')
    .replace(/(купить|в наличии|под линзы|для\s+bi|для\s+би|по выгодной|цена|в ростове|в москве|в\s+nts).*$/i, ' ')
    .replace(yr ? new RegExp(esc(yr.span)) : /$^/, ' ')
    .replace(/г\.?\s?в\.?/gi, ' ')
    .replace(/\((?:вместо|обманк)[^)]*\)/gi, ' ')
    .replace(/(?<![A-Za-z])(без\s+)?afs(?![A-Za-z])|без адаптив\w*|адаптив\w*|ближний свет|дальний свет|ксенон\w*|xenon|галоген\w*|halogen|led|лед|до\s?рестайл\w*|рестайл\w*|рест(?![а-я])|eu|usa|us/gi, ' ')
    .replace(/[\[\](){}]/g, ' ').replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\b\d{5,}\b/g, ' ');
  const norm = cb.normModel(rest);
  add('6. Очистка', 'вычесть годы, комплектацию, «купить/цена/для bi-led…»; нормализовать', norm || '(пусто)');
  if (!norm && !isCrumb) return fin('после очистки пусто');

  let model, gen = '';
  const nm = norm.replace(/-/g, ' ');
  const hit = cb.MULTI.find((p) => nm === p || nm.startsWith(p + ' '));
  let toks = [];
  if (hit) {
    model = hit; gen = nm.slice(hit.length).trim();
    add('7. Модель', 'совпало с готовым списком многословных моделей', `«${model}», остаток «${gen}»`);
  } else {
    toks = norm.split(' ').filter((w) => w && !cb.SERIES.test(w) && !/^(для|линз\w*|ламп\w*)$/.test(w));
    model = toks[0] || '';
    if (cb.NAME_NUM.has(model) && /^\d{1,3}$/.test(toks[1] || '')) { model = `${model}-${toks[1]}`; toks.splice(1, 1); }
    gen = toks.slice(1).filter((w) => /^[a-z0-9]{1,6}$/.test(w)).join(' ');
    add('7. Модель', 'модель = ПЕРВОЕ слово (или «слово+номер» для CX 5, Tiggo 7); всё остальное — кандидаты в код кузова',
      `модель «${model}», остаток «${toks.slice(1).join(' ')}»`);
  }
  add('8. Код кузова', 'из остатка берутся слова из 1–6 латинских букв/цифр (V50, XV50, W204)',
    gen ? `«${gen}»` : '—',
    /(^|\s)[a-z0-9](\s|$)/.test(gen) ? 'ВНИМАНИЕ: в код кузова попал одиночный символ — лишнее слово.' : '');

  const m2 = model.replace(/\s+/g, '-');
  if (!m2 || /[а-яё]/.test(m2) || m2.length > 24 || /^\d{3,}$/.test(m2)) {
    add('9. Проверка модели', 'не пусто, не кириллица, не длиннее 24, не номер изделия', 'ОТБРОШЕНО');
    return fin('модель не прошла проверку');
  }
  add('9. Проверка модели', 'не пусто, не кириллица, не длиннее 24, не номер изделия', `«${slugify(m2) || m2}» — принято`);
  const out = cb.parseTitle(title, host);
  const mine = { make, model: slugify(m2) || m2, gen: gen ? gen.replace(/\s+/g, '-').slice(0, 24) : null,
    year_from: yr ? yr.from : null, year_to: yr ? yr.to : null, restyle: light.restyle, light: light.light, afs: null };
  const same = out && ['make', 'model', 'gen', 'year_from', 'year_to', 'restyle', 'light', 'afs'].every((k) => out[k] === mine[k]);
  add('10. Итог', 'запись наблюдения (car_obs)', JSON.stringify(out));
  return { title, host, steps, rejected: null, result: out, same: !!same };
}

module.exports = { traceTitle };

// ── сравнение «как читает человек» и «как читает код» ──────────────────────
// Ожидание человека для эталонного заголовка luxsar (разбор владельца, 26.09.2026).
const REFERENCE = {
  title: 'Переходные рамки для линз TOYOTA CAMRY V50 2011-2015 с AFS',
  host: 'luxsar.ru',
  human: { make: 'toyota', model: 'camry', gen: 'v50', year_from: 2011, year_to: 2015,
    kind: 'рамка', purpose: 'установка линз' },
};

function compare(human, res) {
  const rows = [];
  const cmp = (label, want, got, why) => rows.push({ label, want, got: got === null || got === undefined ? '—' : got,
    ok: String(want) === String(got), why: String(want) === String(got) ? '' : why });
  const r = res || {};
  cmp('Марка', human.make, r.make, 'марка не найдена');
  cmp('Модель', human.model, r.model, 'модель определена по первому слову после марки (carbase.js:88)');
  cmp('Код кузова', human.gen, r.gen, 'код берётся из остатка после модели; нормализации V50 = XV50 нет, склейка идёт только по годам');
  cmp('Год от', human.year_from, r.year_from, 'шаблон годов не сработал');
  cmp('Год до', human.year_to, r.year_to, 'шаблон годов не сработал');
  const KIND = { frame: 'рамка', glass: 'стекло', housing: 'корпус', kit: 'набор', module: 'модуль', lamp: 'лампа' };
  const gotKind = KIND[r.part_kind] || 'не определён';
  rows.push({ label: 'Вид детали', want: human.kind, got: gotKind, ok: gotKind === human.kind, why: 'вид детали берётся по слову в заголовке (carbase.js partOf)' });
  const gotPurpose = r.purpose === 'install_lens' ? 'установка линз' : 'не определено';
  rows.push({ label: 'Назначение', want: human.purpose, got: gotPurpose, ok: gotPurpose === human.purpose, why: 'назначение — по словам «для/под линз», «замена линз»' });
  return rows;
}

// ── путь записи: документ → наблюдение → машина → комплектация → карточка ──
async function pathOf(title, host) {
  const db = require('../seo/lib/db');
  const out = { docs: [], obs: [], cars: [], variants: [], karta: null };
  out.docs = await db.q(`SELECT d.id, s.host, d.url, d.http_status, d.fetched_at
      FROM documents d JOIN sources s ON s.id = d.source_id
      WHERE d.title = $1 ORDER BY (s.host ~ $2) DESC, d.id LIMIT 5`, [title, host ? host.replace(/\./g, '\\.') : '^$']);
  const parsed = cb.parseTitle(title, host);
  if (!parsed) return out;
  out.obs = await db.q(`SELECT host, url, title, gen, year_from, year_to, restyle, light, afs FROM car_obs
      WHERE make = $1 AND model = $2 AND (year_from IS NULL OR year_from BETWEEN $3 AND $4 OR year_to BETWEEN $3 AND $4)
      ORDER BY host, year_from LIMIT 40`, [parsed.make, parsed.model, (parsed.year_from || 1900) - 1, (parsed.year_to || 2100) + 1]);
  out.cars = await db.q(`SELECT id, year_from, year_to, gens, hosts, n_hosts, mm_hosts, status FROM cars
      WHERE make = $1 AND model = $2 ORDER BY year_from NULLS LAST, year_to`, [parsed.make, parsed.model]);
  const ids = out.cars.map((c) => c.id);
  if (ids.length) out.variants = await db.q(`SELECT car_id, light, afs, restyle, hosts, n_hosts, status FROM car_variants
      WHERE car_id = ANY ($1) ORDER BY car_id, n_hosts DESC`, [ids]);
  try {
    const k = await require('../seo/karta').lookup({ make: parsed.make, model: parsed.model,
      year: String(Math.round(((parsed.year_from || 2012) + (parsed.year_to || parsed.year_from || 2012)) / 2)) });
    const card = k.cards && k.cards[0];
    out.karta = card ? { title: [card.make, card.model].join(' '), years: [card.year_from, card.year_to],
      keys: Object.keys(card).slice(0, 40) } : { found: false };
  } catch (e) { out.karta = { error: e.message }; }
  return out;
}

// ── набор заголовков разных типов (10 штук) ────────────────────────────────
const SAMPLE_SQL = [
  ['luxsar: годы + AFS', `d.title ~* 'рамк' AND d.title ~* 'afs' AND d.title ~ '20\\d\\d' AND s.host ~ 'luxsar'`],
  ['luxsar: без AFS в заголовке', `d.title ~* 'рамк' AND d.title !~* 'afs' AND d.title ~ '20\\d\\d' AND s.host ~ 'luxsar'`],
  ['bi-vision: рестайл', `d.title ~* 'рамк' AND d.title ~* 'рестайл' AND s.host ~ 'bi-vision'`],
  ['bi-vision: марка + модель', `d.title ~* 'рамк' AND s.host ~ 'bi-vision'`],
  ['vdf-light: без годов', `d.title ~* 'рамк' AND s.host ~ 'vdf-light'`],
  ['aozoom-light', `d.title ~* 'рамк' AND s.host ~ 'aozoom'`],
  ['legal-xenon: ксенон/LED', `d.title ~* 'рамк' AND d.title ~* '(ксенон|led)' AND s.host ~ 'legal-xenon'`],
  ['criline', `d.title ~* 'рамк' AND s.host ~ 'criline'`],
  ['стекло вместо рамки (luxsar)', `d.title ~* 'стекл' AND d.title !~* 'рамк' AND s.host ~ 'luxsar'`],
  ['две машины в заголовке', `d.title ~* 'рамк' AND d.title ~ '/' AND s.host ~ '(luxsar|legal|bi-vision|criline)'`],
];
async function samples() {
  const db = require('../seo/lib/db');
  const out = [];
  for (const [label, where] of SAMPLE_SQL) {
    const r = await db.q(`SELECT d.title, s.host FROM documents d JOIN sources s ON s.id = d.source_id
      WHERE d.skip_reason IS NULL AND d.title IS NOT NULL AND ${where} ORDER BY md5(d.title) LIMIT 1`);
    if (r[0]) out.push({ label, ...traceTitle(r[0].title, r[0].host.replace(/^www\./, '')) });
  }
  return out;
}

Object.assign(module.exports, { REFERENCE, compare, pathOf, samples });
