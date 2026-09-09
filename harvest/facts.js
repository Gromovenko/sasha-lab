// Разбор собранных документов в факты: машины, комплектующие, совместимость.
//
// Разбор нарочно тупой и объяснимый — правила, а не модель. Причины:
//   * его видно и можно поправить: неверный факт лечится правкой одного правила,
//     а не «перепромтить и надеяться»;
//   * он бесплатен и переваривает тысячи страниц, тогда как модель на том же
//     объёме стоит денег и упирается в недельный лимит;
//   * он честен в уверенности: правило знает, что оно нашло совпадение слов,
//     и ставит confidence 0.5, а не выдаёт догадку за знание.
// Модель (harvest/facts.js --llm через seo/lib/llm.js) подключается точечно —
// на документах, где правила нашли машину, но не поняли, что с ней делали.
const vehicles = require('./vehicles');
const store = require('./store');

// Известные семейства линз и модулей — то, что реально называют в работах.
// Список правится руками: рынок узкий, новых имён появляется несколько в год.
// Только имена ПРОИЗВОДИТЕЛЕЙ. Короткие обозначения моделей («A3+», «Q5», «G5»)
// в список не входят намеренно: Q5 и A3 — это ещё и модели Audi, и текст «поставили
// линзы в Audi Q5» давал бы факт «в Q5 ставят линзу Q5». Модель подхватывается
// парой «производитель + следующий токен» в lenses() — там неоднозначности нет.
const LENS = [
  'aozoom', 'dragon knight', 'hella', 'koito', 'morimoto',
  'mtf', 'optima', 'dixel', 'sanvi', 'viper', 'zkw', 'valeo', 'bosch', 'sim-?tech',
  'gtr', 'lumen', 'starled', 'zax', 'x-?bright', 'demon', 'cyclone',
];
const LENS_RE = new RegExp(`(?<![a-zа-яё])(${LENS.join('|')})(?![a-zа-яё])`, 'gi');
const SIZE_RE = /\b([23](?:[.,]\d)?)\s*(?:дюйм|")/i;

const APPROACH = [
  [/без\s+вскрыт|не\s+вскрыва/i, 'без вскрытия'],
  [/со?\s+вскрыт|вскрыт(ие|ием|ие\s+фары)|разбор(ка)?\s+фар/i, 'со вскрытием'],
  [/замен[аы]\s+(модул|фары целиком)/i, 'замена модуля'],
];
const HEADLIGHT = [
  [/штатн\w*\s+ксенон|заводск\w*\s+ксенон/i, 'штатный ксенон'],
  [/штатн\w*\s+(led|лед)|заводск\w*\s+led/i, 'штатный led'],
  [/линзован\w*\s+галоген/i, 'линзованный галоген'],
  [/рефлектор\w*|галоген/i, 'галоген'],
];
const DIFFICULTY = [
  [/сложн\w*\s+(работа|фара|случай)|намучил|провозил\w+\s+(весь|два)/i, 'сложная'],
  [/лёгк\w*|легк\w*\s+(работа|фара)|за\s+час/i, 'лёгкая'],
];
const HOURS_RE = /(\d{1,2})\s*(?:час|ч\.)/i;

// Тип комплектующего по названию — для каталога parts.
const PART_KINDS = [
  [/переходн\w*\s+рамк|рамк[аи]|адаптер|крепёж|креплени/i, 'adapter'],
  [/линз|lens|модул/i, 'lens'],
  [/блок\s*розжиг|балласт|ballast|драйвер/i, 'ballast'],
  [/ламп|bulb|цокол|h[1479]\b|hb[34]\b|d[1-4]s\b/i, 'bulb'],
  [/маск|bezel/i, 'mask'],
  [/стекл|glass|рассеиват/i, 'glass'],
  [/герметик|бутил|sealant|клей/i, 'sealant'],
  [/провод|коннектор|разъём|обманк|canbus/i, 'wire'],
  [/съёмник|фен|инструмент|станок/i, 'tool'],
];
const kindOf = (name) => (PART_KINDS.find(([re]) => re.test(name)) || [null, 'other'])[1];

const firstMatch = (rules, text) => (rules.find(([re]) => re.test(text)) || [])[1] || null;

// Имена линз приходят парой «производитель + модель» («Aozoom A3+», «MTF Dynamic»).
// По отдельности это два бесполезных факта: «aozoom» и «a3+» как разные линзы —
// именно так и выглядела первая версия. Поэтому пары склеиваем, а одиночки,
// вошедшие в пару, выбрасываем.
function lenses(text) {
  const hits = [...new Set([...text.matchAll(LENS_RE)].map((m) => m[1].toLowerCase()))];
  const pairs = new Set();
  for (const m of text.matchAll(new RegExp(`(?<![a-zа-яё])(${LENS.join('|')})\\s+([a-z0-9][a-z0-9+.-]{0,9})`, 'gi'))) {
    const [, brand, model] = m;
    if (hits.includes(model.toLowerCase()) || /^[a-z]?\d/i.test(model)) {
      pairs.add(`${brand.toLowerCase()} ${model.toLowerCase()}`);
    }
  }
  const inPair = (h) => [...pairs].some((p) => p.split(' ').includes(h));
  return [...pairs, ...hits.filter((h) => !inPair(h))];
}

// Разбор одного документа → { vehicles:[], fitment:[], part|null }
function parseDoc(doc) {
  const text = String(doc.text || '');
  // На карточке товара машины перечислены ещё и в меню каталога («Land Rover
  // Discovery / Freelander / Range», «Geely / Kia»), и в факты приезжал весь
  // каталог сайта вместо той машины, про которую карточка. Поэтому у parts
  // машину берём только из заголовка — он про товар и ни про что больше.
  const isPart = doc.meta && doc.meta.kind === 'parts';
  const found = vehicles.detect(isPart ? String(doc.title || '') : `${doc.title || ''}\n${text}`);
  const lensHits = lenses(text);
  const size = (text.match(SIZE_RE) || [])[1];
  const approach = firstMatch(APPROACH, text);
  const headlight = firstMatch(HEADLIGHT, text);
  const difficulty = firstMatch(DIFFICULTY, text);
  const hours = Number((text.match(HOURS_RE) || [])[1]) || null;

  const out = { vehicles: found, fitment: [], part: null };

  // Совместимость записываем ТОЛЬКО когда в документе есть и машина, и линза:
  // «страница про Jolion» без названия модуля — это не факт совместимости.
  for (const v of found.slice(0, 5)) {
    for (const lens of lensHits.slice(0, 4)) {
      out.fitment.push({
        vehicleSlug: v.slug, lens: size ? `${lens} ${size}"` : lens,
        approach: approach || '', headlight,
        needs_opening: approach === 'со вскрытием' ? true : approach === 'без вскрытия' ? false : null,
        difficulty, hours,
        // 0.5 = «в одном источнике рядом стоят машина и линза». Повтор в другом
        // источнике поднимет уверенность в store.upsertFitment.
        confidence: 0.5,
      });
    }
  }

  if (isPart && doc.title) {
    const price = doc.meta.price ?? null;
    if (price) {
      out.part = {
        url: doc.url, name: doc.title.slice(0, 300), kind: kindOf(doc.title),
        price_rub: price, source_id: doc.source_id,
        specs: { size: size || undefined, lens: lensHits[0] },
        available: /в наличии|есть в наличии/i.test(text) ? true
          : /нет в наличии|под заказ|распродан/i.test(text) ? false : null,
      };
    }
  }
  return out;
}

// Прогон по неразобранным документам. Возвращает статистику.
async function run({ limit = 500 } = {}) {
  const docs = await store.unparsed(limit);
  const stat = { docs: docs.length, vehicles: 0, fitment: 0, parts: 0 };
  const slugToId = new Map();
  const done = [];

  for (const doc of docs) {
    const parsed = parseDoc(doc);
    for (const v of parsed.vehicles) {
      const id = await store.upsertVehicle(v);
      if (id) slugToId.set(v.slug, id);
      stat.vehicles += 1;
    }
    for (const f of parsed.fitment) {
      const vid = slugToId.get(f.vehicleSlug);
      if (!vid) continue;
      await store.upsertFitment({ ...f, vehicle_id: vid, evidence: [doc.id] });
      stat.fitment += 1;
    }
    if (parsed.part) { await store.upsertPart(parsed.part); stat.parts += 1; }
    done.push(doc.id);
  }
  await store.markParsed(done);
  return stat;
}

module.exports = { parseDoc, run, kindOf, LENS };
