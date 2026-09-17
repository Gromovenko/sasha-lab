// Проверка ворот автостраниц. Самое дорогое здесь — выдуманные цифры: страница
// с ценой, которой нет в фактах, обещает клиенту то, чего студия не говорила.
const test = require('node:test');
const assert = require('node:assert');
const writer = require('../seo/lib/writer');

const ground = {
  phrase: 'сколько служат би лед линзы',
  materials: [{ meta: { title: 'Сколько служат линзы', slug: 'x' }, body: 'Ресурс модуля — около 30000 часов работы.' }],
  facts: [{ make: 'Kia', model: 'Rio', lens: 'Zorkiy A50', hours: 4, status: 'confirmed', notes: '' }],
  questions: [], score: 2, strong: true,
};
const body = (tail) => `Коротко: служат долго.\n\n## Подробности\n${'Текст про ресурс линзы и режим работы. '.repeat(40)}\n\n## Когда так нельзя\n${tail}`;

test('текст с обоснованными числами проходит', () => {
  assert.deepEqual(writer.validate({ title: 'Сколько служат би-LED линзы', rubric: 'linzy', body: body('Ресурс 30000 часов — это заявленный производителем.') }, ground), []);
});

test('выдуманная цена не проходит', () => {
  const errs = writer.validate({ title: 'Сколько служат би-LED линзы', rubric: 'linzy', body: body('Цена вопроса 45000 рублей.') }, ground);
  assert.ok(errs.some((e) => e.includes('45000')), errs.join('; '));
});

test('год в тексте разрешён, вода — нет', () => {
  const errs = writer.validate({ title: 'Сколько служат би-LED линзы', rubric: 'linzy', body: body('С 2015 года ставлю их регулярно. Ни для кого не секрет, что свет важен.') }, ground);
  assert.deepEqual(errs, ['вода: «ни для кого не секрет»']);
});

test('огрызок и чужая рубрика не проходят', () => {
  const errs = writer.validate({ title: 'Коротко', rubric: 'блог', body: '## Ответ\nслужат долго' }, ground);
  assert.ok(errs.some((e) => e.includes('короче')));
  assert.ok(errs.some((e) => e.includes('рубрика')));
});

test('обоснование собирается в текст, по которому и сверяются числа', () => {
  const t = writer.groundingText(ground);
  assert.ok(t.includes('30000'));
  assert.ok(t.includes('Zorkiy A50'));
  assert.deepEqual(writer.bigNumbers('цена 45 000 ₽ и 999 и 2015'), [45000, 2015]);
});
