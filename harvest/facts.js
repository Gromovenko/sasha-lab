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
const kindOf = (name) => (PART_KINDS.find(([re]) => re.test(name)) || [null, 'other'])[1];

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

module.exports = { parseDoc, run, kindOf, lenses, LENS };
