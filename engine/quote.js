// Смета. Считает КОД, а не языковая модель: цена — обязательство, её нельзя
// «примерно сгенерировать». Модель сюда не заглядывает вообще.
//
// Правила расчёта одинаковы для любой отрасли:
//   основные позиции (kind=item) → варианты на выбор клиенту;
//   дополнения (option/work/fee), которые включили правила → отдельной строкой;
//   «что входит» — объединение включённого у выбранных вариантов;
//   итог — от дешёвого варианта до дорогого (клиент выбирает, мастер не гадает).
const rules = require('./rules');

const CURRENCY = { RUB: '₽', USD: '$', EUR: '€' };

function money(n, currency = 'RUB') {
  const sign = CURRENCY[currency] || currency;
  return `${Math.round(Number(n) || 0).toLocaleString('ru-RU').replace(/ /g, ' ')} ${sign}`;
}

// Живые цены лежат в базе (мастер правит их из панели), эталон — в пакете.
// Строка из базы перекрывает пакетную по sku; позиции, которых в пакете нет,
// добавляются (мастер завёл новую услугу, а пакет ещё не обновляли).
function mergeCatalog(pack, overrides = []) {
  const byS = new Map(pack.catalog.map((i) => [i.sku, { ...i }]));
  for (const o of overrides) {
    const base = byS.get(o.sku) || { sku: o.sku, kind: 'item', tags: [], includes: [], sort: 500, enabled: true };
    byS.set(o.sku, {
      ...base,
      title: o.title || base.title,
      price: Number(o.price_rub ?? o.price ?? base.price ?? 0),
      unit: o.unit ?? base.unit,
      kind: o.kind || base.kind,
      tags: o.tags && o.tags.length ? o.tags : base.tags,
      includes: o.includes && o.includes.length ? o.includes : base.includes,
      enabled: o.enabled !== undefined ? o.enabled : base.enabled,
      sort: o.sort ?? base.sort,
    });
  }
  return [...byS.values()];
}

function build(pack, { plan = {}, catalog = null, quantities = {} } = {}) {
  const items = (catalog || pack.catalog).filter((i) => i.enabled !== false);
  const want = rules.tagsForWants(pack, plan.wants || []);
  const wantTags = want.length ? want : (pack.offer.defaultTags || []);
  const need = plan.requireTags || [];
  const skip = plan.excludeTags || [];
  const warnings = [];

  const pick = (tags) => items
    .filter((i) => i.kind === 'item')
    .filter((i) => !tags.length || (i.tags || []).some((t) => tags.includes(t)))
    .filter((i) => need.every((t) => (i.tags || []).includes(t)))
    .filter((i) => !(i.tags || []).some((t) => skip.includes(t)))
    .sort((a, b) => (a.sort || 0) - (b.sort || 0));

  let chosen = pick(wantTags);
  // Ограничение по фото важнее желания: если из-за «мало места» не осталось ни
  // одной позиции, честнее сказать «по фото не подобрать», чем предложить то,
  // что физически не встанет.
  if (!chosen.length && wantTags.length) {
    const wide = pick([]);
    if (wide.length) {
      chosen = wide;
      warnings.push('по запрошенной услуге позиций не нашлось — показаны ближайшие');
    } else {
      warnings.push('под эти ограничения в каталоге нет позиций — нужен осмотр');
    }
  }

  const choices = chosen.slice(0, pack.offer.maxChoices).map((i) => ({
    sku: i.sku, title: i.title, unit: i.unit, tags: i.tags,
    price: i.price, priceText: money(i.price, pack.currency),
  }));

  const extras = (plan.addItems || []).map((sku) => {
    const it = items.find((x) => x.sku === sku);
    if (!it) { warnings.push(`в каталоге нет позиции ${sku}`); return null; }
    const qty = Number(quantities[sku] || 1);
    const sum = it.price * qty;
    return { sku: it.sku, title: it.title, unit: it.unit, qty, price: it.price, sum, sumText: money(sum, pack.currency) };
  }).filter(Boolean);

  const includes = [];
  for (const c of choices) {
    const src = items.find((i) => i.sku === c.sku);
    for (const line of src.includes || []) if (!includes.includes(line)) includes.push(line);
  }

  const extrasSum = extras.reduce((a, x) => a + x.sum, 0);
  const prices = choices.map((c) => c.price);
  const min = (prices.length ? Math.min(...prices) : 0) + extrasSum;
  const max = (prices.length ? Math.max(...prices) : 0) + extrasSum;

  return {
    currency: pack.currency,
    choices,
    extras,
    includes,
    notes: plan.notes || [],
    warnings,
    extrasSum,
    total: { min, max, single: min === max },
    totalText: min === max ? money(min, pack.currency) : `от ${money(min, pack.currency)} до ${money(max, pack.currency)}`,
  };
}

module.exports = { build, money, mergeCatalog };
