// Карточка машины для подбора: марка, модель, годы + наличие стекла, корпуса и
// переходной рамки, сложность разбора и заводской герметик (таблица
// vehicle_parts и вид vehicle_catalog, миграция 007), а с миграции 008 — ещё и
// штатное исполнение фары: адаптивный свет, чем светит ближний с завода, нужны
// ли обманки при замене света и какие лампы стоят в штатных приборах.
//
// Связь «машина → товар» берём не заново из текста, а из уже построенной
// vehicle_links: там марка и модель уже опознаны по адресу, заголовку или факту
// посадки, и повторять разбор второй раз — это и лишний час работы, и второй
// набор ложных срабатываний. parts.url и documents.url — один и тот же адрес
// страницы товара, поэтому связь получается обычным join.
const db = require('../seo/lib/db');

// Какие виды деталей отвечают на вопрос владельца. Остальные (линзы, лампы,
// блоки розжига) в vehicle_parts тоже попадают — карточка их не показывает, но
// иметь их под рукой дешевле, чем пересобирать таблицу при следующей просьбе.
const CATALOG_KINDS = ['glass', 'housing', 'adapter'];

async function rebuild() {
  if (!db.enabled) throw new Error('нужна база (SASHALAB_PG_URL)');
  return db.tx(async (c) => {
    await c.query('DELETE FROM vehicle_parts');
    // basis берём самый надёжный из имеющихся: evidence → url → title.
    await c.query(`
      INSERT INTO vehicle_parts (vehicle_id, part_id, kind, basis)
      SELECT DISTINCT ON (l.vehicle_id, p.id) l.vehicle_id, p.id, p.kind, l.basis
        FROM vehicle_links l JOIN parts p ON p.url = l.url
       ORDER BY l.vehicle_id, p.id,
                CASE l.basis WHEN 'evidence' THEN 0 WHEN 'url' THEN 1 ELSE 2 END`);
    const [r] = (await c.query(`
      SELECT (SELECT count(*) FROM vehicle_parts) AS rows,
             (SELECT count(DISTINCT vehicle_id) FROM vehicle_parts) AS cars,
             (SELECT count(*) FROM vehicle_catalog WHERE glass_offers   > 0) AS glass,
             (SELECT count(*) FROM vehicle_catalog WHERE housing_offers > 0) AS housing,
             (SELECT count(*) FROM vehicle_catalog WHERE adapter_offers > 0) AS adapter,
             (SELECT count(*) FROM vehicle_catalog WHERE teardown_facts > 0) AS teardown,
             (SELECT count(*) FROM vehicle_catalog WHERE sealant IS NOT NULL) AS sealant,
             (SELECT count(*) FROM vehicle_catalog WHERE adaptive IS NOT NULL) AS adaptive,
             (SELECT count(*) FROM vehicle_catalog WHERE low_beam IS NOT NULL) AS low_beam,
             (SELECT count(*) FROM vehicle_catalog WHERE bulb_sockets IS NOT NULL) AS sockets,
             (SELECT count(*) FROM vehicles) AS vehicles`)).rows;
    return r;
  });
}

// Выгрузка для человека: одна строка на машину, ровно те двенадцать полей,
// которые просил владелец (плюс цены — без них «есть» мало что значит).
async function exportRows({ onlyWithData = true } = {}) {
  return db.q(`
    SELECT * FROM vehicle_catalog
     ${onlyWithData ? 'WHERE glass_offers > 0 OR housing_offers > 0 OR adapter_offers > 0'
                    + ' OR teardown_facts > 0 OR sealant IS NOT NULL'
                    + ' OR adaptive IS NOT NULL OR low_beam IS NOT NULL'
                    + ' OR bulb_sockets IS NOT NULL OR canbus_offers > 0' : ''}
     ORDER BY (glass_offers > 0)::int + (housing_offers > 0)::int + (adapter_offers > 0)::int DESC,
              teardown_facts DESC, make, model`);
}

const yesNo = (n) => (n > 0 ? 'есть' : 'нет');
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const yesNoBool = (v) => (v === true ? 'есть' : v === false ? 'нет' : '');
const list = (v) => (Array.isArray(v) ? v.join(', ') : '');
const HEAD = ['марка', 'модель', 'поколение', 'годы', 'стекло фары', 'цена стекла',
  'корпус фары', 'цена корпуса', 'переходная рамка', 'цена рамки',
  'сложность разбора', 'вскрытие', 'часов', 'фактов о разборе',
  'герметик', 'как в источнике', 'фактов о герметике',
  'адаптивный свет', 'фактов об адаптивном', 'штатный ближний', 'как в источнике',
  'фактов о ближнем', 'заводская линза', 'нужна обманка', 'обманки в продаже',
  'цена обманки', 'цоколи штатных ламп', 'штатные приборы'];
const toCsv = (rows) => [HEAD.join(';'), ...rows.map((r) => [
  r.make, r.model, r.generation, [r.year_from, r.year_to].filter(Boolean).join('–'),
  yesNo(r.glass_offers), r.glass_price_min, yesNo(r.housing_offers), r.housing_price_min,
  yesNo(r.adapter_offers), r.adapter_price_min,
  r.difficulty, r.needs_opening === true ? 'нужно' : r.needs_opening === false ? 'не нужно' : '',
  r.hours_max, r.teardown_facts, r.sealant, r.sealant_raw, r.sealant_facts,
  yesNoBool(r.adaptive), r.adaptive_facts, r.low_beam, r.low_beam_raw, r.low_beam_facts,
  r.factory_lens, yesNoBool(r.needs_canbus), yesNo(r.canbus_offers), r.canbus_price_min,
  list(r.bulb_sockets), list(r.bulb_spots),
].map(csvCell).join(';'))].join('\n');

module.exports = { rebuild, exportRows, toCsv, CATALOG_KINDS };
