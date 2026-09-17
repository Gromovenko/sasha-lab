// Конвейер обращения: пришло сообщение → понял → посмотрел фото → посчитал →
// написал готовый ответ → мастер нажал «отправить» → запланировал напоминания.
//
// Ровно тот путь, который сейчас мастер проходит руками за 10–15 минут на
// каждое обращение (и на 80% из них ответ уходит в пустоту). Здесь он занимает
// секунды, а решение остаётся за человеком: движок доводит работу до готового
// текста с ценой, но не отправляет его сам, пока это не разрешено настройкой.
//
// Хранилище передаётся аргументом (store) — по умолчанию база, в тестах
// память. Никакой отраслевой специфики в файле нет: всё, что знает движок про
// бизнес, приезжает из пакета.
const packs = require('./pack');
const rulesEngine = require('./rules');
const quoteEngine = require('./quote');
const offer = require('./offer');
const extract = require('./extract');
const vision = require('./vision');
const files = require('./files');
const channels = require('./channels');
const defaultStore = require('./store');

// off       — всё через руки мастера (по умолчанию: цена — обязательство);
// questions — уточняющие вопросы уходят сразу, расчёт ждёт одобрения;
// all       — отвечает сам (для отраслей, где цена не индивидуальна).
const AUTOSEND = () => (process.env.ENGINE_AUTOSEND || 'off').toLowerCase();

const asArray = (v) => (Array.isArray(v) ? v : v ? JSON.parse(v) : []);
const asObject = (v) => (v && typeof v === 'object' ? v : v ? JSON.parse(v) : {});

// ── 1. приём ───────────────────────────────────────────────────────────────
async function ingest({ pack = packs.DEFAULT_ID, channel, externalId = null, text = '', attachments = [], client = {}, subject = null }, { store = defaultStore } = {}) {
  const deal = await store.deals.open({ pack, channel, externalId, clientName: client.name || null, contact: client.contact || null });
  const saved = [];
  for (const a of attachments) {
    // Файл мог быть уже сохранён каналом (телеграм качает его сам) — тогда в
    // attachments приезжает готовая запись, а не буфер.
    saved.push(a.buffer ? files.save(deal.id, a.filename || 'photo.jpg', a.buffer) : a);
  }
  const message = await store.messages.add({ dealId: deal.id, direction: 'in', channel, author: 'client', text, attachments: saved });
  const patch = {};
  // Поля, заполненные человеком в форме, сильнее того, что потом вытащит модель.
  if (subject && Object.keys(subject).length) patch.subject = extract.merge(subject, asObject(deal.subject));
  if (!deal.client_name && client.name) patch.client_name = client.name;
  if (!deal.client_contact && client.contact) patch.client_contact = client.contact;
  if (!deal.external_id && externalId) patch.external_id = externalId;
  const fresh = Object.keys(patch).length ? await store.deals.update(deal.id, patch) : deal;
  // Клиент написал — значит, старые напоминания больше не актуальны.
  await store.followups.cancel(deal.id);
  return { deal: fresh, message, attachments: saved };
}

// ── 2. зрение по новым фото ────────────────────────────────────────────────
// Смотрим только то, что ещё не смотрели: каждый кадр — это 3–12 с и деньги.
async function lookAtNewPhotos(pack, deal, msgs, store) {
  const found = [];
  const errors = [];
  for (const m of msgs) {
    if (m.direction !== 'in') continue;
    const meta = asObject(m.meta);
    if (meta.vision) continue;
    const imgs = files.images(asArray(m.attachments));
    if (!imgs.length) continue;
    const r = await vision.lookAll(pack, imgs);
    await store.messages.setMeta(m.id, { vision: { at: new Date().toISOString(), engine: r.engine, findings: r.findings, errors: r.errors } });
    found.push(...r.findings);
    errors.push(...r.errors);
  }
  return { found, errors };
}

const mergeFindings = (oldF, newF) => {
  const by = new Map(oldF.map((f) => [f.code, f]));
  for (const f of newF) {
    const prev = by.get(f.code);
    if (!prev || Number(f.confidence) > Number(prev.confidence)) by.set(f.code, f);
  }
  return [...by.values()];
};

// ── 3. разбор, расчёт, черновик ────────────────────────────────────────────
async function think(dealId, { store = defaultStore, autosend = AUTOSEND() } = {}) {
  const deal = await store.deals.byId(dealId);
  if (!deal) throw new Error(`нет сделки ${dealId}`);
  const pack = packs.load(deal.pack);
  const msgs = await store.messages.byDeal(dealId);
  const inbound = msgs.filter((m) => m.direction === 'in');
  const text = inbound.map((m) => m.text).filter(Boolean).join('\n').slice(-6000);

  const known = asObject(deal.subject);
  const got = await extract.extract(pack, { text, known });
  const subject = extract.merge(known, got.subject);

  const before = asArray(deal.findings);
  const seen = await lookAtNewPhotos(pack, deal, msgs, store);
  const findings = mergeFindings(before, seen.found);

  const photos = inbound.reduce((n, m) => n + files.images(asArray(m.attachments)).length, 0);
  const ctx = { subject, request: asObject(deal.request), text, findings, photos, wants: got.wants };
  const plan = rulesEngine.evaluate(pack, ctx);

  // Недостающие обязательные поля, про которые не спросило ни одно правило:
  // без этого универсальный пакет пришлось бы дублировать правилом на каждое поле.
  const missing = extract.missing(pack, subject);
  const askedByRules = new Set(pack.rules.filter((r) => plan.fired.includes(r.id) && r.when?.absent)
    .map((r) => String(r.when.absent).replace(/^subject\./, '')));
  for (const key of missing) {
    if (askedByRules.has(key)) continue;
    const f = pack.subject.fields.find((x) => x.key === key);
    const q = f?.ask || `Подскажите, ${String(f?.label || key).toLowerCase()} — это важно для расчёта.`;
    if (!plan.questions.includes(q)) plan.questions.push(q);
  }

  let catalog = null;
  try { catalog = quoteEngine.mergeCatalog(pack, await store.catalog.list(pack.id)); } catch { catalog = null; }
  const quote = quoteEngine.build(pack, { plan, catalog });

  const draftBody = offer.compose(pack, { quote, plan, subject, client: { name: deal.client_name } });
  // Почему ответ изменился — видно мастеру и попадает в историю ревизий:
  // «переделываю ответ» из живой переписки здесь становится строчкой в карточке.
  const fresh = seen.found.filter((f) => !before.some((b) => b.code === f.code));
  const reason = fresh.length
    ? `уточнено по фото: ${fresh.map((f) => pack.vision.findings.find((x) => x.code === f.code)?.label || f.code).join(', ')}`
    : draftBody.reason;

  const prev = await store.drafts.latest(dealId);
  const changed = !prev || prev.text !== draftBody.text || prev.status !== 'pending';
  const draft = changed
    ? await store.drafts.add({ dealId, kind: draftBody.kind, text: draftBody.text, quote, reason, engine: draftBody.engine })
    : prev;

  const stage = deal.stage === 'won' || deal.stage === 'lost' ? deal.stage
    : draftBody.kind === 'question' ? 'clarify' : 'quoted';
  const updated = await store.deals.update(dealId, {
    subject, findings: JSON.stringify(findings), missing,
    quote: JSON.stringify(quote), total_rub: quote.total.min || null, stage,
  });

  let sent = null;
  if (changed && (autosend === 'all' || (autosend === 'questions' && draftBody.kind === 'question'))) {
    sent = await send(dealId, { draftId: draft.id, store });
  }
  return { deal: updated, draft, plan, quote, findings, visionErrors: seen.errors, extract: got, sent };
}

// ── 4. отправка ────────────────────────────────────────────────────────────
async function send(dealId, { draftId = null, text = null, store = defaultStore } = {}) {
  const deal = await store.deals.byId(dealId);
  if (!deal) throw new Error(`нет сделки ${dealId}`);
  const pack = packs.load(deal.pack);
  const draft = draftId ? await store.drafts.byId(draftId) : await store.drafts.pending(dealId);
  const body = text || draft?.text;
  if (!body) throw new Error('нечего отправлять: нет черновика');
  const to = deal.external_id || deal.client_contact;
  const r = await channels.send(deal.channel, { to, text: body, subject: pack.offer.title || 'Ваш расчёт', deal });

  await store.messages.add({
    dealId, direction: 'out', channel: deal.channel, author: 'master', text: body,
    meta: { draftId: draft?.id || null, externalId: r.id || null, manual: Boolean(r.manual), fallback: r.fallback || null, error: r.error || null },
    sentAt: r.ok ? new Date() : null, error: r.ok ? null : r.error,
  });
  if (r.ok && draft) await store.drafts.markSent(draft.id);
  if (r.ok) {
    await store.deals.update(dealId, { stage: deal.stage === 'won' || deal.stage === 'lost' ? deal.stage : 'sent' });
    // Догоняющие касания — то, ради чего вообще стоит вести сделку в системе:
    // «80% ответов в пустоту» лечится вторым и третьим касанием, а не текстом.
    const steps = (pack.followups || []).filter((s) => channels.get(deal.channel).sessionHours == null || Number(s.afterHours) < channels.get(deal.channel).sessionHours);
    if (steps.length) await store.followups.plan(dealId, steps, new Date());
  }
  return r;
}

// ── 5. напоминания ─────────────────────────────────────────────────────────
async function runFollowups({ store = defaultStore, now = new Date(), limit = 50 } = {}) {
  const due = await store.followups.due(now, limit);
  const out = [];
  for (const f of due) {
    const r = await channels.send(f.channel, { to: f.external_id || f.client_contact, text: f.text, subject: 'Напоминание' });
    await store.messages.add({
      dealId: f.deal_id, direction: 'out', channel: f.channel, author: 'assistant', text: f.text,
      meta: { followup: f.step, manual: Boolean(r.manual), error: r.error || null },
      sentAt: r.ok ? now : null, error: r.ok ? null : r.error,
    });
    if (r.ok) await store.followups.markSent(f.id);
    out.push({ deal: f.deal_id, step: f.step, ok: r.ok, manual: Boolean(r.manual), error: r.error || null });
  }
  return out;
}

// Полный путь одним вызовом — им пользуются канал, форма сайта и cli.
async function handleIncoming(args, opts = {}) {
  const { deal } = await ingest(args, opts);
  return think(deal.id, opts);
}

module.exports = { ingest, think, send, runFollowups, handleIncoming, mergeFindings, AUTOSEND };
