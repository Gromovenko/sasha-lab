// База автомобилей «марка — модель — год» из каталогов переходных рамок и
// перекрёстная сверка источников. Чистая логика разбора и сведения — здесь,
// работа с базой — внизу (rebuild/exportRows).
//
// Правило подтверждения: машина (марка + модель + годы) confirmed, только если
// её видят минимум ДВА РАЗНЫХ сайта и годы у них совпали (допуск ±1 год: сайты
// по-разному округляют «2010-2016» и «2010-2015»). Комплектации фары одной
// машины (свет × AFS × рестайл) — не разные машины: они живут в car_variants
// со своим счётом источников.
const db = require('../seo/lib/db');
const { makeOf, slugify, MAKES } = require('./vehicles');

const LET = 'A-Za-zА-Яа-яЁё';
const MAKE_RE = new RegExp(`(?<![${LET}])(${MAKES.map(([, re]) => re).join('|')})(?![${LET}])`, 'i');
const NOW_YEAR = 2026;
const TOL = 1;

// Модели из нескольких слов: без списка «Land Cruiser Prado» стал бы моделью «land».
const MULTI = ['land cruiser prado', 'land cruiser', 'range rover evoque', 'range rover sport', 'range rover',
  'grand cherokee', 'santa fe', 'grand vitara', 'grand scenic', 'x trail', 'cross country', 'model 3', 'model y',
  'model s', 'model x', 'a class', 'c class', 'e class', 's class', 'g class', 'lancer evolution', 'mark ii'];
// «Tiggo 7», «CX 5», «RX 350»: название из слова и номера — одна модель, а не модель+поколение.
const NAME_NUM = new Set(['cx', 'rx', 'nx', 'lx', 'gx', 'ux', 'tiggo', 'ix', 'qx', 'mx', 'cs', 'eq', 'ex', 'id', 'gl', 'glk', 'gla', 'glc', 'gle', 'gls', 'ml', 'x', 'jolion', 'coolray']);
const SERIES = /^(серии|серия|series|класса|класс|class)$/i;

function years(s) {
  let m = s.match(/((?:19|20)\d{2})\s*[-–—]\s*((?:19|20)\d{2}|н\.?\s?в\.?|наст\.?\s?вр\.?)/i);
  if (m) {
    const to = /\d/.test(m[2]) ? Number(m[2]) : NOW_YEAR;
    return { from: Number(m[1]), to, span: m[0] };
  }
  m = s.match(/\b(\d{2})\s*[-–—]\s*(\d{2})\s*г\.?\s?в/i);
  if (m) {
    const f = 2000 + Number(m[1]), t = 2000 + Number(m[2]);
    if (f <= t) return { from: f, to: t, span: m[0] };
  }
  return null;
}

// Комплектация фары. «BI-LED» и «biled» — это тип ЛИНЗЫ для замены, а не штатный
// свет, поэтому вырезаем до поиска «LED».
function lightOf(s) {
  const t = s.replace(/би[-\s]?лед|bi[-\s]?led|biled/gi, ' ');
  let light = null;
  if (/ксенон|xenon/i.test(t)) light = 'xenon';
  else if (/галоген|halogen/i.test(t)) light = 'halogen';
  else if (/(?<![A-Za-zА-Яа-я])(led|лед)(?![A-Za-zА-Яа-я])|светодиод/i.test(t)) light = 'led';
  let afs = null;
  if (/без\s*afs|без\s*адаптив/i.test(t)) afs = false;
  else if (/(?<![A-Za-z])afs(?![A-Za-z])|адаптив/i.test(t)) afs = true;
  let restyle = null;
  if (/до\s?рест|pre[-\s]?facelift/i.test(t)) restyle = 'pre';
  else if (/рестайл|рест(?![а-я])|facelift/i.test(t)) restyle = 'restyle';
  return { light, afs, restyle };
}

const normModel = (s) => s.toLowerCase().replace(/[^a-zа-яё0-9\s-]/gi, ' ').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

// Заголовок каталога → наблюдение или null.
function parseTitle(title, host) {
  if (!title || !/рамк/i.test(title)) return null;
  // «Переходные рамки → Lynk & Co → 900» (vdf-light): марка и модель без годов.
  let t = String(title).replace(/&bull;|&amp;/g, ' ').replace(/:\s*цены.*$/i, '');
  const bc = t.split('→').map((x) => x.trim());
  const isCrumb = bc.length > 1;
  if (isCrumb) t = bc.slice(1).join(' ');
  const mk = MAKE_RE.exec(t);
  if (!mk) return null;
  const make = makeOf(mk[1]);
  if (!make) return null;
  // Номерные/общие рамки и лишние марки-упоминания («lexus / toyota [f94]») не режем:
  // берём первую марку, модель — текст сразу после неё.
  let rest = t.slice(mk.index + mk[0].length);
  const light = lightOf(t);
  const yr = years(t);
  rest = rest.replace(/[\/].*$/, ' ')             // «lexus / toyota …» — вторая марка не модель
    .replace(/(купить|в наличии|под линзы|для\s+bi|для\s+би|по выгодной|цена|в ростове|в москве|в\s+nts).*$/i, ' ')
    .replace(yr ? yr.span.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '$^', ' ')
    .replace(/г\.?\s?в\.?/gi, ' ')
    .replace(/\((?:вместо|обманк)[^)]*\)/gi, ' ')
    .replace(/(?<![A-Za-z])(без\s+)?afs(?![A-Za-z])|без адаптив\w*|адаптив\w*|ближний свет|дальний свет|ксенон\w*|xenon|галоген\w*|halogen|led|лед|до\s?рестайл\w*|рестайл\w*|рест(?![а-я])|eu|usa|us/gi, ' ')
    .replace(/[\[\](){}]/g, ' ').replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\b\d{5,}\b/g, ' ');
  const norm = normModel(rest);
  if (!norm && !isCrumb) return null;
  let model, gen = '';
  const nm = norm.replace(/-/g, ' ');
  const hit = MULTI.find((p) => nm === p || nm.startsWith(p + ' '));
  if (hit) { model = hit; gen = nm.slice(hit.length).trim(); }
  else {
    const toks = norm.split(' ').filter((w) => w && !SERIES.test(w) && !/^(для|линз\w*|ламп\w*)$/.test(w));
    model = toks[0] || '';
    if (NAME_NUM.has(model) && /^\d{1,3}$/.test(toks[1] || '')) { model = `${model}-${toks[1]}`; toks.splice(1, 1); }
    gen = toks.slice(1).filter((w) => /^[a-z0-9]{1,6}$/.test(w)).join(' ');
  }
  // Гибкость «Лi L7 / Ли Л7»: кириллица в модели — след неопознанной марки, теряем.
  model = model.replace(/\s+/g, '-');
  if (!model || /[а-яё]/.test(model) || model.length > 24) return null;
  if (/^\d{3,}$/.test(model)) return null;   // «рамки #128» — номер изделия
  return {
    host, make, model: slugify(model) || model, gen: gen ? gen.replace(/\s+/g, '-').slice(0, 24) : null,
    year_from: yr ? yr.from : null, year_to: yr ? yr.to : null,
    restyle: light.restyle, light: light.light, afs: light.afs,
  };
}

const agree = (a, b) => Math.abs(a.year_from - b.year_from) <= TOL && Math.abs(a.year_to - b.year_to) <= TOL;
const mode = (arr) => {
  const c = new Map();
  for (const v of arr) c.set(v, (c.get(v) || 0) + 1);
  return [...c.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0];
};

// Наблюдения → машины и комплектации.
function consolidate(obs) {
  const byMM = new Map();
  for (const o of obs) {
    const k = `${o.make}|${o.model}`;
    if (!byMM.has(k)) byMM.set(k, []);
    byMM.get(k).push(o);
  }
  const cars = [];
  for (const [, list] of byMM) {
    const mmHosts = [...new Set(list.map((o) => o.host))].sort();
    const withY = list.filter((o) => o.year_from != null).sort((a, b) => a.year_from - b.year_from || a.year_to - b.year_to);
    const clusters = [];
    for (const o of withY) {
      const c = clusters.find((cl) => agree(cl.ref, o));
      if (c) { c.items.push(o); c.ref = { year_from: mode(c.items.map((i) => i.year_from)), year_to: mode(c.items.map((i) => i.year_to)) }; }
      else clusters.push({ items: [o], ref: { year_from: o.year_from, year_to: o.year_to } });
    }
    for (const c of clusters) {
      const hosts = [...new Set(c.items.map((i) => i.host))].sort();
      cars.push({
        make: list[0].make, model: list[0].model, year_from: c.ref.year_from, year_to: c.ref.year_to,
        gens: [...new Set(c.items.map((i) => i.gen).filter(Boolean))].slice(0, 8),
        hosts, n_hosts: hosts.length, mm_hosts: mmHosts,
        status: hosts.length >= 2 ? 'confirmed' : 'single', items: c.items,
      });
    }
    const noY = list.filter((o) => o.year_from == null);
    if (noY.length && !clusters.length) {
      const hosts = [...new Set(noY.map((i) => i.host))].sort();
      cars.push({ make: list[0].make, model: list[0].model, year_from: null, year_to: null, gens: [], hosts: [], n_hosts: 0,
        mm_hosts: mmHosts, status: 'no_year', items: noY });
    }
    // Наблюдения без годов у модели с годами: подтверждают марку+модель (mm_hosts), но не годы.
  }
  // Комплектации: наблюдение садится в машину с наибольшим пересечением годов.
  for (const car of cars) car.variants = [];
  const pool = new Map();
  for (const [, list] of byMM) {
    const mine = cars.filter((c) => c.make === list[0].make && c.model === list[0].model);
    for (const o of list) {
      if (o.light == null && o.afs == null && o.restyle == null) continue;
      let best = null, bestOv = 0;
      for (const c of mine) {
        if (o.year_from == null || c.year_from == null) { if (mine.length === 1) best = c; continue; }
        const ov = Math.min(o.year_to, c.year_to) - Math.max(o.year_from, c.year_from) + 1;
        if (ov > bestOv) { bestOv = ov; best = c; }
      }
      if (!best) continue;
      const vk = `${o.light}|${o.afs}|${o.restyle}`;
      let v = best.variants.find((x) => x.key === vk);
      if (!v) { v = { key: vk, light: o.light, afs: o.afs, restyle: o.restyle, hosts: new Set() }; best.variants.push(v); }
      v.hosts.add(o.host);
    }
  }
  for (const car of cars) {
    car.variants = car.variants.map((v) => ({ light: v.light, afs: v.afs, restyle: v.restyle,
      hosts: [...v.hosts].sort(), n_hosts: v.hosts.size, status: v.hosts.size >= 2 ? 'confirmed' : 'single' }));
    delete car.items;
  }
  return cars;
}

async function rebuild() {
  const rows = (await db.q(`
    SELECT s.host, d.url, d.title FROM documents d JOIN sources s ON s.id = d.source_id
    WHERE d.skip_reason IS NULL AND d.title ~* 'рамк' AND s.host ~
      '(nts-auto|bi-vision|daoptika|ledcar|aozoom-light|vdf-light|luxsar|criline|legal-xenon)'`));
  const obs = [];
  for (const r of rows) {
    const o = parseTitle(r.title, r.host.replace(/^www\./, ''));
    if (o) obs.push({ ...o, url: r.url, title: r.title });
  }
  await db.q('TRUNCATE car_obs, cars, car_variants RESTART IDENTITY CASCADE');
  for (let i = 0; i < obs.length; i += 500) {
    const ch = obs.slice(i, i + 500);
    const vals = [], args = [];
    ch.forEach((o, j) => {
      const b = j * 11;
      vals.push(`(${Array.from({ length: 11 }, (_, k) => `$${b + k + 1}`).join(',')})`);
      args.push(o.host, o.url, o.title, o.make, o.model, o.gen, o.year_from, o.year_to, o.restyle, o.light, o.afs);
    });
    await db.q(`INSERT INTO car_obs (host,url,title,make,model,gen,year_from,year_to,restyle,light,afs) VALUES ${vals.join(',')} ON CONFLICT (url) DO NOTHING`, args);
  }
  const cars = consolidate(obs);
  for (const c of cars) {
    const r = await db.one(`INSERT INTO cars (make,model,year_from,year_to,gens,hosts,n_hosts,mm_hosts,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [c.make, c.model, c.year_from, c.year_to, c.gens, c.hosts, c.n_hosts, c.mm_hosts, c.status]);
    for (const v of c.variants) {
      await db.q('INSERT INTO car_variants (car_id,light,afs,restyle,hosts,n_hosts,status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [r.id, v.light, v.afs, v.restyle, v.hosts, v.n_hosts, v.status]);
    }
  }
  const st = (await db.q(`SELECT status, count(*)::int n FROM cars GROUP BY 1`));
  return { pages: rows.length, parsed: obs.length, cars: cars.length, byStatus: st };
}

async function exportRows({ onlyConfirmed = true } = {}) {
  return (await db.q(`
    SELECT c.make, c.model, c.year_from, c.year_to, c.status, c.n_hosts, array_to_string(c.hosts, ' ') hosts,
      array_to_string(c.gens, ' ') gens,
      (SELECT string_agg(concat_ws(' ', coalesce(v.light,'свет?'), CASE v.afs WHEN true THEN 'AFS' WHEN false THEN 'без AFS' END,
          CASE v.restyle WHEN 'pre' THEN 'дорест' WHEN 'restyle' THEN 'рест' END, '[' || v.n_hosts || (CASE WHEN v.status='confirmed' THEN ' ✓' ELSE '' END) || ']'), '; ')
         FROM car_variants v WHERE v.car_id = c.id) variants
    FROM cars c ${onlyConfirmed ? "WHERE c.status='confirmed'" : ''}
    ORDER BY c.make, c.model, c.year_from`));
}

const toCsv = (rows) => {
  const cols = ['make', 'model', 'year_from', 'year_to', 'status', 'n_hosts', 'hosts', 'gens', 'variants'];
  const esc = (v) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`);
  return [cols.join(';')].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(';'))).join('\n');
};

module.exports = { parseTitle, consolidate, rebuild, exportRows, toCsv, lightOf, years,
  MAKE_RE, MULTI, NAME_NUM, SERIES, normModel };
