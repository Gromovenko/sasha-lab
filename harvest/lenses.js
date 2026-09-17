// Имена линз и модулей — отдельным модулем, потому что список нужен двоим:
// разборщику фактов (что поставили) и распознавателю машин (что НЕ является
// моделью). Пока список жил внутри facts.js, «Honda Insight Morimoto retrofit»
// давало машину «Insight Morimoto»: имя линзы прилипало к модели.
//
// Список правится руками: рынок узкий, новых имён появляется несколько в год.
// Только имена ПРОИЗВОДИТЕЛЕЙ. Короткие обозначения моделей («A3+», «Q5», «G5»)
// в список не входят намеренно: Q5 и A3 — это ещё и модели Audi, и текст «поставили
// линзы в Audi Q5» давал бы факт «в Q5 ставят линзу Q5». Модель подхватывается
// парой «производитель + следующий токен» в lenses() — там неоднозначности нет.
const LENS = [
  'aozoom', 'dragon knight', 'hella', 'koito', 'morimoto',
  'mtf', 'optima', 'dixel', 'sanvi', 'viper', 'zkw', 'valeo', 'bosch', 'sim-?tech',
  'gtr', 'lumen', 'starled', 'zax', 'x-?bright', 'demon', 'cyclone',
  // Английские источники (hidplanet.com): то, что ставят на американском рынке.
  'depo', 'stanley', 'ichikoh', 'denso', 'philips', 'osram', 'matsushita',
  'magneti marelli', 'automotive lighting', 'aharon', 'acme', 'retroquik', 'apollo',
];
const LENS_RE = new RegExp(`(?<![a-zа-яё])(${LENS.join('|')})(?![a-zа-яё])`, 'gi');
const PAIR_RE = new RegExp(`(?<![a-zа-яё])(${LENS.join('|')})\\s+([a-z0-9][a-z0-9+.-]{0,9})`, 'gi');
// Токен целиком — имя производителя линз: нужен разбору машин как стоп-слово.
const WORD_RE = new RegExp(`^(?:${LENS.join('|')})$`, 'i');

// Имена линз приходят парой «производитель + модель» («Aozoom A3+», «MTF Dynamic»).
// По отдельности это два бесполезных факта: «aozoom» и «a3+» как разные линзы —
// именно так и выглядела первая версия. Поэтому пары склеиваем, а одиночки,
// вошедшие в пару, выбрасываем.
function lenses(text) {
  const hits = [...new Set([...String(text).matchAll(LENS_RE)].map((m) => m[1].toLowerCase()))];
  const pairs = new Set();
  for (const m of String(text).matchAll(PAIR_RE)) {
    const [, brand, raw] = m;
    // «Hella 3R.» в конце предложения — точка не часть модели.
    const model = raw.replace(/[.,;:-]+$/, '');
    if (!model) continue;
    if (hits.includes(model.toLowerCase()) || /^[a-z]?\d/i.test(model)) {
      pairs.add(`${brand.toLowerCase()} ${model.toLowerCase()}`);
    }
  }
  const inPair = (h) => [...pairs].some((p) => p.split(' ').includes(h));
  return [...pairs, ...hits.filter((h) => !inPair(h))];
}

const isLensWord = (token) => WORD_RE.test(String(token).trim());

module.exports = { LENS, LENS_RE, lenses, isLensWord };
