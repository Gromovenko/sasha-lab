// Хранилище в памяти с тем же интерфейсом, что engine/store.js. Нужно тестам:
// конвейер проверяется целиком, без postgres и без сети — на EU базы проекта
// нет вовсе (персданные живут только на RU), а тесты должны идти везде.
function memoryStore() {
  const st = { deals: new Map(), messages: [], drafts: [], followups: [], catalog: new Map(), seq: 0 };
  const now = () => new Date();
  const id = () => `d_${++st.seq}`;

  const deals = {
    async create({ pack, channel, externalId = null, clientName = null, contact = null, subject = {}, request = {} }) {
      const row = { id: id(), pack, channel, external_id: externalId, client_name: clientName, client_contact: contact,
        subject, request, findings: [], missing: [], stage: 'new', quote: null, total_rub: null, note: null,
        created_at: now(), updated_at: now(), last_in_at: now(), last_out_at: null };
      st.deals.set(row.id, row);
      return row;
    },
    async byId(i) { return st.deals.get(i) || null; },
    async byExternal(channel, externalId) { return [...st.deals.values()].find((d) => d.channel === channel && d.external_id === externalId) || null; },
    async open(a) { return (a.externalId && await deals.byExternal(a.channel, a.externalId)) || deals.create(a); },
    async list({ stage = null, limit = 100 } = {}) {
      return [...st.deals.values()].filter((d) => !stage || d.stage === stage)
        .sort((a, b) => b.updated_at - a.updated_at).slice(0, limit);
    },
    async update(i, patch) {
      const d = st.deals.get(i);
      Object.assign(d, patch, { updated_at: now() });
      return d;
    },
    async stats() { return { total: st.deals.size }; },
  };

  const messages = {
    async add(m) {
      const row = { id: st.messages.length + 1, deal_id: m.dealId, direction: m.direction, channel: m.channel,
        author: m.author || null, text: m.text || '', attachments: m.attachments || [], meta: m.meta || {},
        created_at: now(), sent_at: m.sentAt || null, error: m.error || null };
      st.messages.push(row);
      const d = st.deals.get(m.dealId);
      if (d) { d[m.direction === 'in' ? 'last_in_at' : 'last_out_at'] = now(); d.updated_at = now(); }
      return row;
    },
    async byDeal(dealId) { return st.messages.filter((m) => m.deal_id === dealId); },
    async setMeta(i, meta) { const m = st.messages.find((x) => x.id === i); Object.assign(m.meta, meta); },
    async markSent(i, error = null) { const m = st.messages.find((x) => x.id === i); m.sent_at = now(); m.error = error; },
  };

  const drafts = {
    async add({ dealId, kind = 'offer', text, quote = null, reason = null, engine = 'template' }) {
      const prev = await drafts.latest(dealId);
      if (prev && prev.status === 'pending') prev.status = 'dropped';
      const row = { id: st.drafts.length + 1, deal_id: dealId, kind, rev: (prev?.rev || 0) + 1, text, quote,
        reason, engine, status: 'pending', created_at: now(), sent_at: null };
      st.drafts.push(row);
      return row;
    },
    async latest(dealId) { return [...st.drafts].reverse().find((d) => d.deal_id === dealId) || null; },
    async pending(dealId) { return [...st.drafts].reverse().find((d) => d.deal_id === dealId && d.status === 'pending') || null; },
    async byId(i) { return st.drafts.find((d) => d.id === i) || null; },
    async markSent(i) { const d = st.drafts.find((x) => x.id === i); d.status = 'sent'; d.sent_at = now(); },
    async drop(i) { const d = st.drafts.find((x) => x.id === i); d.status = 'dropped'; },
  };

  const followups = {
    async plan(dealId, steps, from = now()) {
      st.followups = st.followups.filter((f) => !(f.deal_id === dealId && f.status === 'planned'));
      for (const s of steps) {
        st.followups.push({ id: st.followups.length + 1, deal_id: dealId, step: Number(s.step),
          due_at: new Date(from.getTime() + Number(s.afterHours) * 3600e3), text: s.text, status: 'planned', sent_at: null });
      }
      return st.followups.filter((f) => f.deal_id === dealId);
    },
    async due(at = now(), limit = 50) {
      return st.followups.filter((f) => f.status === 'planned' && f.due_at <= at)
        .map((f) => ({ ...f, ...pickDeal(f.deal_id) }))
        .filter((f) => !['won', 'lost', 'spam'].includes(f.stage))
        .filter((f) => !f.last_in_at || !f.last_out_at || f.last_in_at < f.last_out_at)
        .slice(0, limit);
    },
    async markSent(i) { const f = st.followups.find((x) => x.id === i); f.status = 'sent'; f.sent_at = now(); },
    async cancel(dealId) { for (const f of st.followups) if (f.deal_id === dealId && f.status === 'planned') f.status = 'cancelled'; },
    async byDeal(dealId) { return st.followups.filter((f) => f.deal_id === dealId); },
  };

  function pickDeal(dealId) {
    const d = st.deals.get(dealId) || {};
    return { pack: d.pack, channel: d.channel, external_id: d.external_id, client_contact: d.client_contact,
      stage: d.stage, last_in_at: d.last_in_at, last_out_at: d.last_out_at };
  }

  const catalog = {
    async list(pack) { return [...(st.catalog.get(pack) || [])]; },
    async sync(pack) { st.catalog.set(pack.id, pack.catalog.map((i) => ({ ...i, price_rub: i.price }))); return { total: pack.catalog.length, added: pack.catalog.length }; },
    async setPrice(pack, sku, price) { const row = (st.catalog.get(pack) || []).find((i) => i.sku === sku); if (row) row.price_rub = price; },
    async setEnabled(pack, sku, on) { const row = (st.catalog.get(pack) || []).find((i) => i.sku === sku); if (row) row.enabled = on; },
  };

  return { deals, messages, drafts, followups, catalog, _state: st };
}

module.exports = { memoryStore };
