// Правила пакета: условия → решения. Ни одного «если фара», только данные.
//
// Зачем правила отдельным слоем, а не «пусть модель сама сообразит»: цена и
// состав работ — это обязательство перед клиентом. Модель ошибается молча и
// каждый раз по-разному, правило ошибается одинаково и видно в тесте. Модель
// у нас занимается тем, что умеет: вынимает смысл из текста и с фото. Решение
// «что предлагать и почём» принимает этот файл.
//
// Условия (when):
//   { text: ["обманк", ...] }      — подстрока в переписке клиента
//   { finding: "tight_space" }     — зрение увидело это на фото
//   { absent: "subject.year" }     — поля нет или оно пустое
//   { present: "subject.model" }
//   { equals: { path, value } }
//   { photos: 0 } | { photosLt: 2 }— сколько фото прислали
//   { any: [...] } | { all: [...] } | { not: {...} }
// Решения (then):
//   addItem: "sku" | ["sku"]       — дополнение в смету
//   requireTags / excludeTags      — сузить каталог (мало места → только компактные)
//   note: "…"                      — абзац в КП
//   ask: "…"                       — вопрос клиенту, пока данных не хватает
//   flag: "…"                      — пометка на карточке

const MIN_CONFIDENCE = Number(process.env.FINDING_MIN_CONFIDENCE || 0.5);

const path = (obj, p) => String(p).split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);

function matches(when, ctx) {
  if (!when || typeof when !== 'object') return false;
  if (when.any) return when.any.some((w) => matches(w, ctx));
  if (when.all) return when.all.every((w) => matches(w, ctx));
  if (when.not) return !matches(when.not, ctx);
  if (when.text) {
    const hay = String(ctx.text || '').toLowerCase();
    if (![].concat(when.text).some((s) => hay.includes(String(s).toLowerCase()))) return false;
  }
  if (when.finding) {
    const codes = [].concat(when.finding);
    const got = (ctx.findings || []).filter((f) => Number(f.confidence ?? 1) >= MIN_CONFIDENCE).map((f) => f.code);
    if (!codes.some((c) => got.includes(c))) return false;
  }
  if (when.absent && !isEmpty(path(ctx, when.absent))) return false;
  if (when.present && isEmpty(path(ctx, when.present))) return false;
  if (when.equals && String(path(ctx, when.equals.path) ?? '') !== String(when.equals.value)) return false;
  if (when.photos != null && Number(ctx.photos || 0) !== Number(when.photos)) return false;
  if (when.photosLt != null && !(Number(ctx.photos || 0) < Number(when.photosLt))) return false;
  return true;
}

const pushUnique = (arr, v) => { for (const x of [].concat(v || [])) if (x && !arr.includes(x)) arr.push(x); };

function applyThen(then, plan, source) {
  if (!then) return;
  pushUnique(plan.addItems, then.addItem);
  pushUnique(plan.requireTags, then.requireTags);
  pushUnique(plan.excludeTags, then.excludeTags);
  pushUnique(plan.notes, then.note);
  pushUnique(plan.questions, then.ask);
  pushUnique(plan.flags, then.flag);
  plan.fired.push(source);
}

// Что хочет клиент — по словам пакета. Ничего умного: это фильтр каталога,
// а не понимание. Тонкие случаи достаются модели в extract.js.
function detectWants(pack, text) {
  const hay = String(text || '').toLowerCase();
  return pack.wants.filter((w) => (w.words || []).some((s) => hay.includes(String(s).toLowerCase()))).map((w) => w.key);
}

function tagsForWants(pack, wants) {
  const out = [];
  for (const w of pack.wants) if (wants.includes(w.key)) pushUnique(out, w.tags || []);
  return out;
}

function evaluate(pack, ctx) {
  const plan = { addItems: [], requireTags: [], excludeTags: [], notes: [], questions: [], flags: [], fired: [] };
  for (const r of pack.rules) if (matches(r.when, ctx)) applyThen(r.then, plan, r.id || 'rule');
  // Находки зрения — это доказательство с фото; их решения применяются после
  // текстовых правил, чтобы «вижу мало места» перебивало общий разговор.
  const seen = (ctx.findings || []).filter((f) => Number(f.confidence ?? 1) >= MIN_CONFIDENCE);
  for (const f of seen) {
    const def = pack.vision.findings.find((x) => x.code === f.code);
    if (def) applyThen(def.then, plan, `finding:${f.code}`);
  }
  plan.wants = ctx.wants && ctx.wants.length ? ctx.wants : detectWants(pack, ctx.text);
  return plan;
}

module.exports = { evaluate, matches, detectWants, tagsForWants, MIN_CONFIDENCE };
