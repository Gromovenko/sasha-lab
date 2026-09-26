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
const { LENS, lenses } = require('./lenses');

const SIZE_RE = /\b([23](?:[.,]\d)?)\s*(?:дюйм|"|''|inch|inches)/i;

// Английские правила стоят рядом с русскими, а не отдельным разборщиком:
// факт один и тот же («фару вскрывали», «штатный ксенон»), меняется только язык
// источника. Слова взяты из живых заголовков hidplanet.com: там «вскрытие» — это
// «bake/open the headlight» и «butyl», а «без вскрытия» — «plug and play».
const APPROACH = [
  [/без\s+вскрыт|не\s+вскрыва|plug\s*[-&nн]?\s*(?:and|n)?\s*play|\bpnp\b|no\s+cutting/i, 'без вскрытия'],
  [/со?\s+вскрыт|вскрыт(ие|ием|ие\s+фары)|разбор(ка)?\s+фар|bak(?:e|ed|ing)\s+(?:the\s+)?(?:headlight|housing)|open(?:ed|ing)?\s+(?:up\s+)?(?:the\s+)?(?:headlight|housing)|butyl|reseal/i, 'со вскрытием'],
  [/замен[аы]\s+(модул|фары целиком)|housing\s+swap|headlight\s+swap|retrofit\s+housings?/i, 'замена модуля'],
];
const HEADLIGHT = [
  [/штатн[\wа-яёА-ЯЁ]*\s+ксенон|заводск[\wа-яёА-ЯЁ]*\s+ксенон|(?:factory|oem|stock)\s+(?:bi-?)?(?:hid|xenon)/i, 'штатный ксенон'],
  [/штатн[\wа-яёА-ЯЁ]*\s+(led|лед)|заводск[\wа-яёА-ЯЁ]*\s+led|(?:factory|oem|stock)\s+led/i, 'штатный led'],
  [/линзован[\wа-яёА-ЯЁ]*\s+галоген|halogen\s+projector/i, 'линзованный галоген'],
  [/рефлектор[\wа-яёА-ЯЁ]*|галоген|halogen|reflector/i, 'галоген'],
];
const DIFFICULTY = [
  [/сложн[\wа-яёА-ЯЁ]*\s+(работа|фара|случай)|намучил|провозил[\wа-яёА-ЯЁ]+\s+(весь|два)|nightmare|pain\s+in\s+the|tricky|difficult/i, 'сложная'],
  [/лёгк[\wа-яёА-ЯЁ]*|легк[\wа-яёА-ЯЁ]*\s+(работа|фара)|за\s+час|easy\s+(?:job|install|retrofit)|straightforward/i, 'лёгкая'],
];
const HOURS_RE = /(\d{1,2})\s*(?:час|ч\.|hours?\b|hrs?\b)/i;

// Завод. конструктив фары — отдельно от того, что доустановили (см. HEADLIGHT выше).
const SEALANT = [
  [/полиуретан[\wа-яёА-ЯЁ]*|polyurethane/i, 'полиуретановый герметик'],
  // Бутил отдельным правилом и ПЕРЕД битумом: для мастера это главное различие
  // («греется и переплавляется» против «не переплавляется»), а «битумным» в
  // мастерских часто зовут ту же бутиловую ленту — сведение обоих к одному
  // ответу делает vehicle_catalog, здесь формулировку источника не теряем.
  [/бутил[\wа-яёА-ЯЁ]*|butyl/i, 'бутиловый герметик'],
  [/битум[\wа-яёА-ЯЁ]*|bitumen/i, 'битумный герметик'],
  [/термоклей|hot[\s-]*melt/i, 'термоклей'],
  [/силикон[\wа-яёА-ЯЁ]*(?!\s*смазк)|silicone/i, 'силиконовый герметик'],
];
const ADAPTIVE_RE = /адаптивн[\wа-яёА-ЯЁ]*\s+(?:фар|свет)|\bafs\b|поворотн[\wа-яёА-ЯЁ]*\s+модул|динамическ[\wа-яёА-ЯЁ]*\s+свет|bending\s+light|cornering\s+light|adaptive\s+(?:headlight|beam|front[\s-]?lighting)/i;
const LOW_BEAM_SOURCE = [
  [/би-?ксенон[\wа-яёА-ЯЁ]*|bi-?xenon/i, 'биксенон'],
  [/штатн[\wа-яёА-ЯЁ]*\s+ксенон|заводск[\wа-яёА-ЯЁ]*\s+ксенон|(?:factory|oem|stock)\s+(?:hid|xenon)/i, 'штатный ксенон'],
  [/штатн[\wа-яёА-ЯЁ]*\s+(?:led|лед)|заводск[\wа-яёА-ЯЁ]*\s+led|(?:factory|oem|stock)\s+led/i, 'штатный led'],
  [/лазерн[\wа-яёА-ЯЁ]*\s+свет|laser\s+light/i, 'лазерный'],
  [/галоген[\wа-яёА-ЯЁ]*|halogen/i, 'галоген'],
];
// Известные производители заводских линз/модулей — имя рядом со словом «завод./штатн.»
const FACTORY_LENS_RE = /(?:заводск[\wа-яёА-ЯЁ]*|штатн[\wа-яёА-ЯЁ]*|oem|factory|stock)[^.\n]{0,20}\b(hella|valeo|koito|magneti\s*marelli|denso|stanley|visteon|jw\s*speaker|amp)\b[^.\n]{0,20}/i;

// Тип комплектующего по названию — для каталога parts.
const PART_KINDS = [
  [/переходн[\wа-яёА-ЯЁ]*\s+рамк|рамк[аи]|адаптер|крепёж|креплени/i, 'adapter'],
  // Корпус фары — до линз и масок: в названии карточки почти всегда стоит
  // «корпус фары под линзы …», и без этого правила такой товар уезжал в lens.
  [/корпус[\wа-яёА-ЯЁ]*\s+(?:фар|блок-?фар|оптик)|блок-?фар[аи]\s+в\s+сборе|headlight\s+housing/i, 'housing'],
  [/линз|lens|модул/i, 'lens'],
  [/блок\s*розжиг|балласт|ballast|драйвер/i, 'ballast'],
  [/ламп|bulb|цокол|h[1479]\b|hb[34]\b|d[1-4]s\b/i, 'bulb'],
  [/маск|bezel/i, 'mask'],
  [/стекл|glass|рассеиват/i, 'glass'],
  [/герметик|бутил|sealant|клей/i, 'sealant'],
  [/провод|коннектор|разъём|обманк|canbus/i, 'wire'],
  [/съёмник|фен|инструмент|станок/i, 'tool'],
];
// Виды из расширения карточки (запрос владельца 25.09.2026, пункты 13–18). Идут
// ДО общего списка: «набор линз для фар Hella 3R» иначе уезжает в lens, а плата
// ДХО — в bulb по слову «ДХО» рядом с лампами. Каждое правило узкое, и у него есть
// свой стоп-список: «Светодиодные лампы … в Задние поворотники» — это лампа, а не
// модуль поворота, и она остаётся в bulb.
const PART_KINDS_FIRST = [
  // 18. набор для модернизации фар (пример — vdf-light «наборы для модернизации»)
  [/набор[\wа-яё]*\s+(?:линз|для\s+(?:установки|замены|модернизации)|замены|модернизации)|комплект[\wа-яё]*\s+для\s+(?:установки|замены|модернизации)\s+(?:линз|фар)|модернизаци[ияю]\s+фар/i, 'kit', /рамк|лампы?\s|блок\s+розжиг/i],
  // 16. штатный блок управления светом (не замка и не салона)
  [/(?:блок|модул[ьи])\s+управлени[яе]\s+(?:фар|светом|освещени|адаптивн)/i, 'control'],
  // 17. модули ДХО / поворота / боковой подсветки / подсветки колец
  [/ангельск|глазк|плат[аы]\s+дхо|модул[\wа-яё]*\s+(?:дхо|drl|поворот|боков|подсвет)|\bhalo\b|подсветк[\wа-яё]*\s+кол[еь]ц/i, 'drl', /рамк|маск|бленд|лампы?\s|линз|контроллер/i],
];
// 13–14. фара в сборе конкретной машины. Идёт ПОСЛЕ общего списка и только для
// того, что там осталось «other»: корпус, стекло и блок-фара в сборе уже разобраны.
// «фара диодная» и «Светодиодная фара 42W» — универсальные прожекторы, не штатные.
const HEADLIGHT_RE = /^(?:купить\s+)?фара\s+[A-Za-z]/i;
const HEADLIGHT_ANALOG_RE = /аналог|\b(?:depo|dept|tyc|junyan|eagle\s*eyes?|sonar|fpk|carbuy)\b|оригинальн[\wа-яё]*\s+качеств|копи[яию]|replica/i;
const HEADLIGHT_OEM_RE = /оригинал|\boem\b|genuine|original/i;
// electro-kot.ru: 27 тыс. страниц вида «Светодиодные лампы для Peugeot 408 with Xenon
// 2010-2016 в Ближний свет». Линзы там нет, но пометка комплектации в названии —
// готовый факт о штатном свете этой машины (пункт 10 карточки). Пишем его как
// fitment с пустой линзой; страницы /baza такие строки в порог фактов не считают.
const LAMP_TITLE_RE = /^Светодиодные лампы для (.+?)(?:\s+в\s+[^\d]+?)?(?:\s+купить)?\s*$/i;
const LAMP_MARK_RE = /\s+(?:with|с)\s+(xenon|led|ксенон\w*|галоген\w*)\b/i;
const LAMP_TITLE_SOURCE = (w) => /xenon|ксенон/i.test(w) ? 'штатный ксенон'
  : /led/i.test(w) ? 'штатный led' : 'галоген';
// Модель на electro-kot часто цифровая («Peugeot 408») или с кодом кузова
// («BMW 3 (E46)»), поэтому общий detect() её не видит: разбираем строку каталога
// по её собственному шаблону «для МАРКА МОДЕЛЬ [with Xenon] ГОДЫ [в МЕСТО]».
function parseLampTitle(title) {
  const m = String(title || '').match(LAMP_TITLE_RE);
  if (!m) return null;
  const mark = m[1].match(LAMP_MARK_RE);
  if (!mark) return null;
  const y = m[1].match(vehicles.YEAR_RE);
  let body = m[1].slice(0, y ? y.index : undefined).replace(LAMP_MARK_RE, ' ');
  body = body.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = body.split(' ');
  let make = null; let n = 0;
  for (const k of [2, 1]) { make = vehicles.makeOf(words.slice(0, k).join(' ')); if (make) { n = k; break; } }
  const model = words.slice(n).join(' ').replace(/[-–—,.:;]+$/, '').trim();
  if (!make || model.length < 2) return null;
  const a = y ? Number(y[1]) : null; const b = y && y[2] ? Number(y[2]) : null;
  return {
    source: LAMP_TITLE_SOURCE(mark[1]),
    vehicle: { make, model, slug: `${make}-${vehicles.slugify(model)}`, yearFrom: a, yearTo: b || a,
      hits: 1, snippet: String(title).slice(0, 200) },
  };
}
const kindOf = (name) => {
  for (const [re, kind, stop] of PART_KINDS_FIRST) if (re.test(name) && !(stop && stop.test(name))) return kind;
  const base = (PART_KINDS.find(([re]) => re.test(name)) || [null, 'other'])[1];
  if (base !== 'other' || !HEADLIGHT_RE.test(name)) return base;
  if (HEADLIGHT_ANALOG_RE.test(name)) return 'headlight_analog';
  if (HEADLIGHT_OEM_RE.test(name)) return 'headlight_oem';
  return 'headlight';
};

const firstMatch = (rules, text) => (rules.find(([re]) => re.test(text)) || [])[1] || null;

// Разбор одного документа → { vehicles:[], fitment:[], part|null }
function parseDoc(doc) {
  const text = String(doc.text || '');
  // На карточке товара машины перечислены ещё и в меню каталога («Land Rover
  // Discovery / Freelander / Range», «Geely / Kia»), и в факты приезжал весь
  // каталог сайта вместо той машины, про которую карточка. Поэтому у parts
  // машину берём только из заголовка — он про товар и ни про что больше.
  const isPart = doc.meta && doc.meta.kind === 'parts';
  // Язык источника меняет разбор марок: в английском «mini h1» — это линза
  // Morimoto Mini, а не BMW Mini (см. EN_AMBIGUOUS в vehicles.js).
  const lang = (doc.meta && doc.meta.lang) || 'ru';
  const found = vehicles.detect(isPart ? String(doc.title || '') : `${doc.title || ''}\n${text}`, { lang });
  const lensHits = lenses(text);
  const size = (text.match(SIZE_RE) || [])[1];
  const approach = firstMatch(APPROACH, text);
  const headlight = firstMatch(HEADLIGHT, text);
  const difficulty = firstMatch(DIFFICULTY, text);
  const hours = Number((text.match(HOURS_RE) || [])[1]) || null;
  const sealant = firstMatch(SEALANT, text);
  const adaptive = ADAPTIVE_RE.test(text) ? true : null;
  const lowBeamSource = firstMatch(LOW_BEAM_SOURCE, text);
  const factoryLensMatch = text.match(FACTORY_LENS_RE);
  const factoryLens = factoryLensMatch ? factoryLensMatch[1].replace(/\s+/g, ' ') : null;

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
        sealant, adaptive, low_beam_source: lowBeamSource, factory_lens: factoryLens,
        // 0.5 = «в одном источнике рядом стоят машина и линза». Повтор в другом
        // источнике поднимет уверенность в store.upsertFitment.
        confidence: 0.5,
      });
    }
  }

  const lampTitle = isPart ? parseLampTitle(doc.title) : null;
  if (lampTitle) {
    // Заголовок каталога точнее общего поиска марки в тексте страницы: он же
    // и годы даёт правильные, и не плодит «mercedes-sprinter» рядом с «-906».
    out.vehicles = [lampTitle.vehicle];
    out.fitment = [{
      vehicleSlug: lampTitle.vehicle.slug, lens: '', approach: '', headlight: null,
      needs_opening: null, difficulty: null, hours: null, sealant: null, adaptive: null,
      low_beam_source: lampTitle.source, factory_lens: null, confidence: 0.6,
    }];
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
async function run({ limit = 500, reparse = false } = {}) {
  if (reparse) await store.resetFacts();
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

module.exports = { parseLampTitle, parseDoc, run, kindOf, lenses, LENS };
