// Распознавание «марка — модель — год» в живом тексте.
//
// Зачем машина в центре схемы: спрос в автосвете задаётся не услугой, а машиной.
// «Установка линз» ищут единицы, «билед линзы haval jolion» — сотни, и список
// моделей меняется быстрее, чем что-либо ещё: за два года верх рынка заняли
// китайские марки, у которых своя фара и свои нюансы. Поэтому марки лежат
// списком в коде (его правит человек), а модели ВЫНИМАЮТСЯ из источников —
// иначе справочник устареет ровно к моменту, когда станет нужен.
const MAKES = [
  // Китай — то, что сейчас реально едет в сервис
  ['haval', 'хавал|хавейл|haval'], ['chery', 'чери|черри|chery'],
  ['geely', 'джили|жили|geely'], ['exeed', 'эксид|exeed'],
  ['omoda', 'омода|omoda'], ['jaecoo', 'джейку|jaecoo'],
  ['changan', 'чанган|changan'], ['jetour', 'джетур|jetour'],
  ['tank', 'танк|tank'], ['gac', 'gac|гак'], ['byd', 'byd|бид'],
  ['lixiang', 'li\\s?xiang|лисян|理想'], ['zeekr', 'zeekr|зикр'],
  ['belgee', 'belgee|белджи'], ['moskvich', 'москвич|moskvich'],
  ['dongfeng', 'dongfeng|донгфенг|дунфэн'], ['faw', 'faw'],
  ['jac', 'jac'], ['livan', 'livan|ливан'], ['kaiyi', 'kaiyi|кайи'],
  ['soueast', 'soueast'], ['hongqi', 'hongqi|хончи'], ['voyah', 'voyah|вояж'],
  // Массовые «долгоиграющие» — их фары в работе будут всегда
  ['toyota', 'тойота|toyota'], ['lexus', 'лексус|lexus'],
  ['nissan', 'ниссан|nissan'], ['infiniti', 'инфинити|infiniti'],
  ['mazda', 'мазда|mazda'], ['honda', 'хонда|honda'],
  ['mitsubishi', 'митсубиси|мицубиси|mitsubishi'], ['subaru', 'субару|subaru'],
  ['hyundai', 'хендай|хёндай|хундай|hyundai'], ['kia', 'киа|kia'],
  ['volkswagen', 'фольксваген|вольксваген|volkswagen|vw'],
  ['skoda', 'шкода|skoda|škoda'], ['audi', 'ауди|audi'],
  ['bmw', 'бмв|bmw'], ['mercedes', 'мерседес|mercedes|mercedes-benz'],
  ['opel', 'опель|opel'], ['ford', 'форд|ford'], ['chevrolet', 'шевроле|chevrolet'],
  ['renault', 'рено|renault'], ['peugeot', 'пежо|peugeot'], ['citroen', 'ситроен|citroen|citroën'],
  ['volvo', 'вольво|volvo'], ['land-rover', 'ленд ровер|land\\s?rover'],
  ['jeep', 'джип|jeep'], ['porsche', 'порше|porsche'],
  ['lada', 'лада|lada|ваз'], ['uaz', 'уаз|uaz'], ['gaz', 'газель|gaz'],
  ['datsun', 'датсун|datsun'], ['ssangyong', 'санг\\s?йонг|ssangyong'],
  ['great-wall', 'great\\s?wall'], ['suzuki', 'сузуки|suzuki'],
];

// Границу слова НЕ берём через \b: в JS он опирается на латиницу, и перед «Тойота»
// границы нет вовсе — кириллические марки просто не находились. Отсюда явные
// проверки «слева/справа не буква».
const LET = 'A-Za-zА-Яа-яЁё';
const MAKE_RE = new RegExp(`(?<![${LET}])(${MAKES.map(([, re]) => re).join('|')})(?![${LET}])`, 'gi');
const CANON = MAKES.map(([slug, re]) => [slug, new RegExp(`^(?:${re})$`, 'i')]);

const TR = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'j',к:'k',л:'l',м:'m',
  н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',
  ь:'',э:'e',ю:'yu',я:'ya' };
const slugify = (s) => String(s).toLowerCase().replace(/[а-яё]/g, (c) => TR[c] ?? c)
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

function makeOf(word) {
  const w = word.toLowerCase().replace(/\s+/g, ' ');
  for (const [slug, re] of CANON) if (re.test(w)) return slug;
  return null;
}

// Слова, которые НЕ модель, хотя стоят сразу за маркой. Без этого списка
// в справочник приезжают «haval фары» и «kia линзы» как отдельные машины.
const STOP = new RegExp('^(фар|фары|фарах|фару|фар[аеиоуы]?|линз|линзы|линз[аеуы]?|би|bi|led|лед|ксенон|'
  + 'галоген|стекл|стекло|ремонт|установк|тюнинг|полировк|бронировани|модуль|блок|лампа|лампы|'
  + 'цена|отзыв|купить|для|под|на|в|с|и|или|а|но|это|все|весь|владелец|машин|авто|автомобил|'
  + 'привет|всем|доброго|сегодня|вчера|вот|как|что|где|когда|почему|можно|нужно)$', 'i');

// Модель: первый токен — слово, следующие два могут быть цифрой или приставкой
// («tiggo 7 pro», «camry 70», «tank 300»). Годы отсекаются ниже отдельно.
const HEAD = `[${LET}][${LET}0-9-]{0,14}`;
// Хвостовой токен берём, только если это цифра или латиница («7 pro», «70», «NG»):
// кириллическое слово после модели — почти всегда обычная речь («Rio тоже»,
// «W211 рестайлинг»), и оно склеивалось в имя машины.
const TAIL = `(?:[0-9][0-9A-Za-z-]{0,9}|[A-Za-z][A-Za-z0-9-]{0,14})`;
// Разделитель — пробел или таб, но НЕ перевод строки: иначе имя склеивается через
// границу абзаца («Линзы в Audi Q5\nAudi Q5 2015» давало модель «Q5 Audi Q5»).
const MODEL_RE = new RegExp(`^[ \t]*(${HEAD}(?:[ \t]+${TAIL}){0,2})`);

// Год либо диапазон рядом с упоминанием: «2021», «2019-2023», «2021 г.в.»
const YEAR_RE = /\b(19[89]\d|20[0-3]\d)\s*(?:[-–—]\s*(19[89]\d|20[0-3]\d))?\s*(?:г\.?\s*в\.?|год|г\.)?/;

// Возвращает [{ make, model, slug, yearFrom, yearTo, snippet }]
function detect(text) {
  const found = new Map();
  const s = String(text || '');
  for (const m of s.matchAll(MAKE_RE)) {
    const make = makeOf(m[1]);
    if (!make) continue;
    const tail = s.slice(m.index + m[1].length, m.index + m[1].length + 60);
    const mm = tail.match(MODEL_RE);
    let model = mm ? mm[1].trim() : '';
    // отрезаем хвост после стоп-слова: «tiggo 7 pro фары» → «tiggo 7 pro»
    const parts = [];
    for (const p of model.split(/\s+/)) {
      if (STOP.test(p)) break;
      if (/(?:19|20)\d{2}/.test(p)) break;    // «Kia Rio 2015», «Rio 2015-2019» — год, не имя
      parts.push(p);
    }
    model = parts.join(' ').replace(/[-–—,.:;]+$/, '').trim();
    if (!model || model.length < 2) continue;
    if (/^\d{4}$/.test(model)) continue;                 // «kia 2021» — это не модель

    // Год ищем в узком окне вокруг упоминания: широкое окно тащило год соседней
    // машины из того же абзаца и приписывало его всем подряд.
    const around = s.slice(Math.max(0, m.index - 15),
      m.index + m[1].length + (mm ? mm[1].length : 0) + 25);
    const y = around.match(YEAR_RE);
    const key = `${make}|${model.toLowerCase()}`;
    const prev = found.get(key);
    const rec = prev || {
      make, model, slug: `${make}-${slugify(model)}`,
      yearFrom: null, yearTo: null, hits: 0,
      snippet: around.replace(/\s+/g, ' ').trim().slice(0, 200),
    };
    rec.hits += 1;
    if (y) {
      const a = Number(y[1]); const b = y[2] ? Number(y[2]) : null;
      rec.yearFrom = rec.yearFrom ? Math.min(rec.yearFrom, a) : a;
      rec.yearTo = Math.max(rec.yearTo || 0, b || a) || null;
    }
    found.set(key, rec);
  }
  return [...found.values()].sort((a, b) => b.hits - a.hits);
}

module.exports = { detect, makeOf, slugify, MAKES, YEAR_RE };
