// Текст ответа клиенту. Собирается ШАБЛОНОМ пакета из посчитанной сметы —
// то есть цифры в письме ровно те, что посчитал quote.js, буква в букву.
//
// Модель (если включена) может ПРИЧЕСАТЬ текст, но не изменить его смысл: после
// неё стоит сторож sameNumbers — если в причёсанном тексте пропала, изменилась
// или появилась цифра, правка выбрасывается и уходит шаблонный вариант.
// Цена ошибки здесь — обещание клиенту, которое мастер не выполнит.
const { render, tidy } = require('./render');

// Числа «значимые» — от 100: год выпуска и «3 дюйма» модель имеет право
// переставить, а вот 45000 и 1500 обязаны остаться нетронутыми.
function numbers(text) {
  return (String(text).match(/\d[\d\s ]*\d|\d+/g) || [])
    .map((s) => Number(s.replace(/[\s ]/g, '')))
    .filter((n) => Number.isFinite(n) && n >= 100)
    .sort((a, b) => a - b);
}

const sameNumbers = (a, b) => {
  const x = numbers(a);
  const y = numbers(b);
  return x.length === y.length && x.every((n, i) => n === y[i]);
};

// Причёсанный моделью текст принимаем, только если цифры целы и длина
// правдоподобна (модель любит «ужать» КП до двух строк — это потеря состава работ).
function guardPolish(base, polished) {
  if (!polished || typeof polished !== 'string') return null;
  const p = polished.trim();
  if (!sameNumbers(base, p)) return null;
  if (p.length < base.length * 0.6 || p.length > base.length * 2) return null;
  return p;
}

function context(pack, { quote, plan = {}, subject = {}, client = {} }) {
  const brand = pack.brand || {};
  return {
    ...brand,
    title: pack.offer.title || '',
    subtitle: pack.offer.subtitle || '',
    greeting: pack.greeting || 'Здравствуйте!',
    name: client.name || '',
    subject,
    choices: (quote?.choices || []).map((c) => ({ ...c, price: c.priceText })),
    extras: (quote?.extras || []).map((e) => ({ ...e, sum: e.sumText })),
    hasExtras: Boolean(quote?.extras?.length),
    includes: quote?.includes || [],
    notes: plan.notes || [],
    hasNotes: Boolean((plan.notes || []).length),
    questions: plan.questions || [],
    hasQuestions: Boolean((plan.questions || []).length),
    total: quote?.totalText || '',
    closing: render(pack.offer.closing || '', brand),
  };
}

// Главный вход: по сметe и плану решает, что сейчас уместно отправить —
// расчёт или уточняющий вопрос. Это ровно развилка живого мастера:
// «данных хватает → пишу цену», «не хватает → спрашиваю, но не молчу».
function compose(pack, args) {
  const ctx = context(pack, args);
  const quote = args.quote;
  const canPrice = Boolean(quote?.choices?.length);
  if (!canPrice) {
    return {
      kind: 'question',
      engine: 'template',
      text: tidy(render(pack.offer.questionTemplate || '{{greeting}}\n{{#questions}}— {{.}}\n{{/questions}}', ctx)),
      reason: quote?.warnings?.join('; ') || 'не хватает данных для расчёта',
    };
  }
  let text = tidy(render(pack.offer.template, ctx));
  // Вопросы не отменяют расчёт: клиент видит цену сразу (у него ещё три таких
  // диалога в других сервисах) и отвечает на уточнения по ходу.
  if (ctx.hasQuestions) {
    text += `\n\nЧтобы посчитать точно, уточните:\n${ctx.questions.map((q) => `— ${q}`).join('\n')}`;
  }
  return { kind: 'offer', engine: 'template', text, reason: (args.plan?.notes || []).length ? 'учтены особенности заявки' : null };
}

function followupText(pack, step) {
  const f = (pack.followups || []).find((x) => Number(x.step) === Number(step));
  return f ? render(f.text, pack.brand || {}) : null;
}

module.exports = { compose, context, numbers, sameNumbers, guardPolish, followupText };
