// Хранилище сделок. Та же дисциплина, что у seo/lib/store: если базы нет
// (dev-копия на EU), модуль не падает на загрузке — падает конкретный вызов,
// и панель показывает «нет хранилища», а сайт продолжает работать.
const crypto = require('crypto');
const db = require('../seo/lib/db');

const newId = () => `d_${crypto.randomBytes(5).toString('hex')}`;
const ts = (r) => (r && r.created_at instanceof Date ? r.created_at.toISOString() : r?.created_at);

const deals = {
  async create({ pack, channel, externalId = null, clientName = null, contact = null, subject = {}, request = {} }) {
    const id = newId();
    const [row] = await db.q(
      `INSERT INTO deals (id, pack, channel, external_id, client_name, client_contact, subject, request, last_in_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now()) RETURNING *`,
      [id, pack, channel, externalId, clientName, contact, subject, request]);
    return row;
  },

  byId: (id) => db.one('SELECT * FROM deals WHERE id=$1', [id]),
  byExternal: (channel, externalId) => db.one('SELECT * FROM deals WHERE channel=$1 AND external_id=$2', [channel, externalId]),

  // Одна дверь для «пришло сообщение»: либо продолжаем существующий диалог,
  // либо заводим сделку. Без этого каждое «а сколько?» плодит новую карточку.
  async open({ pack, channel, externalId, clientName, contact }) {
    if (externalId) {
      const got = await deals.byExternal(channel, externalId);
      if (got) return got;
    }
    return deals.create({ pack, channel, externalId, clientName, contact });
  },

  list: ({ stage = null, limit = 100 } = {}) => db.q(
    `SELECT * FROM deals ${stage ? 'WHERE stage = $2' : ''} ORDER BY updated_at DESC LIMIT $1`,
    stage ? [limit, stage] : [limit]),

  async update(id, patch) {
    const cols = { subject: 1, request: 1, findings: 1, missing: 1, stage: 1, quote: 1, total_rub: 1, note: 1, client_name: 1, client_contact: 1, external_id: 1, last_in_at: 1, last_out_at: 1 };
    const keys = Object.keys(patch).filter((k) => cols[k]);
    if (!keys.length) return deals.byId(id);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const [row] = await db.q(`UPDATE deals SET ${sets}, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, ...keys.map((k) => patch[k])]);
    return row;
  },

  // Сводка для панели мастера: сколько ждёт ответа и сколько висит без движения.
  stats: async () => (await db.q(`
    SELECT count(*) FILTER (WHERE stage IN ('new','clarify')) AS waiting,
           count(*) FILTER (WHERE stage = 'quoted') AS quoted,
           count(*) FILTER (WHERE stage = 'sent') AS sent,
           count(*) FILTER (WHERE stage = 'won') AS won,
           count(*) FILTER (WHERE stage NOT IN ('won','lost','spam') AND last_in_at > last_out_at) AS unanswered,
           count(*) AS total FROM deals`))[0],
};

const messages = {
  async add({ dealId, direction, channel, author = null, text = '', attachments = [], meta = {}, sentAt = null, error = null }) {
    const [row] = await db.q(
      `INSERT INTO deal_messages (deal_id, direction, channel, author, text, attachments, meta, sent_at, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [dealId, direction, channel, author, text, JSON.stringify(attachments), meta, sentAt, error]);
    await db.q(`UPDATE deals SET ${direction === 'in' ? 'last_in_at' : 'last_out_at'} = now(), updated_at = now() WHERE id=$1`, [dealId]);
    return row;
  },
  byDeal: (dealId) => db.q('SELECT * FROM deal_messages WHERE deal_id=$1 ORDER BY created_at, id', [dealId]),
  setMeta: (id, meta) => db.q('UPDATE deal_messages SET meta = meta || $2::jsonb WHERE id=$1', [id, JSON.stringify(meta)]),
  markSent: (id, error = null) => db.q('UPDATE deal_messages SET sent_at = now(), error = $2 WHERE id=$1', [id, error]),
};

const drafts = {
  async add({ dealId, kind = 'offer', text, quote = null, reason = null, engine = 'template' }) {
    const prev = await drafts.latest(dealId);
    // Прошлый неотправленный черновик снимаем: два «актуальных ответа» в карточке
    // это ровно тот случай, когда мастер в гараже отправит клиенту устаревший.
    if (prev && prev.status === 'pending') await db.q("UPDATE deal_drafts SET status='dropped' WHERE id=$1", [prev.id]);
    const rev = (prev?.rev || 0) + 1;
    const [row] = await db.q(
      `INSERT INTO deal_drafts (deal_id, kind, rev, text, quote, reason, engine)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [dealId, kind, rev, text, quote ? JSON.stringify(quote) : null, reason, engine]);
    return row;
  },
  latest: (dealId) => db.one('SELECT * FROM deal_drafts WHERE deal_id=$1 ORDER BY id DESC LIMIT 1', [dealId]),
  pending: (dealId) => db.one("SELECT * FROM deal_drafts WHERE deal_id=$1 AND status='pending' ORDER BY id DESC LIMIT 1", [dealId]),
  byId: (id) => db.one('SELECT * FROM deal_drafts WHERE id=$1', [id]),
  markSent: (id) => db.q("UPDATE deal_drafts SET status='sent', sent_at=now() WHERE id=$1", [id]),
  drop: (id) => db.q("UPDATE deal_drafts SET status='dropped' WHERE id=$1", [id]),
};

const followups = {
  // План строится от последнего исходящего: «через 4 часа», «через двое суток».
  // Пересоставляется целиком при каждой отправке — иначе после ответа мастера
  // клиент получит напоминание, назначенное неделю назад.
  async plan(dealId, steps, from = new Date()) {
    await db.q("DELETE FROM deal_followups WHERE deal_id=$1 AND status='planned'", [dealId]);
    const out = [];
    for (const s of steps) {
      const due = new Date(from.getTime() + Number(s.afterHours) * 3600e3);
      const [row] = await db.q(
        `INSERT INTO deal_followups (deal_id, step, due_at, text) VALUES ($1,$2,$3,$4)
         ON CONFLICT (deal_id, step) DO UPDATE SET due_at=$3, text=$4, status='planned', sent_at=NULL RETURNING *`,
        [dealId, Number(s.step), due, s.text]);
      out.push(row);
    }
    return out;
  },
  due: (now = new Date(), limit = 50) => db.q(
    `SELECT f.*, d.pack, d.channel, d.external_id, d.client_contact, d.stage
       FROM deal_followups f JOIN deals d ON d.id = f.deal_id
      WHERE f.status='planned' AND f.due_at <= $1
        AND d.stage NOT IN ('won','lost','spam')
        AND (d.last_in_at IS NULL OR d.last_out_at IS NULL OR d.last_in_at < d.last_out_at)
      ORDER BY f.due_at LIMIT $2`, [now, limit]),
  markSent: (id) => db.q("UPDATE deal_followups SET status='sent', sent_at=now() WHERE id=$1", [id]),
  cancel: (dealId) => db.q("UPDATE deal_followups SET status='cancelled' WHERE deal_id=$1 AND status='planned'", [dealId]),
  byDeal: (dealId) => db.q('SELECT * FROM deal_followups WHERE deal_id=$1 ORDER BY step', [dealId]),
};

const catalog = {
  list: (pack) => db.q('SELECT * FROM catalog WHERE pack=$1 ORDER BY sort, sku', [pack]),
  // Наливка из файла пакета: цену НЕ трогаем, если строка уже есть — её мог
  // поправить мастер из панели, и выкат кода не должен откатывать прайс.
  async sync(pack) {
    let added = 0;
    for (const i of pack.catalog) {
      const r = await db.q(
        `INSERT INTO catalog (pack, sku, kind, title, price_rub, unit, tags, includes, enabled, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (pack, sku) DO UPDATE SET title=EXCLUDED.title, kind=EXCLUDED.kind,
           unit=EXCLUDED.unit, tags=EXCLUDED.tags, includes=EXCLUDED.includes, sort=EXCLUDED.sort,
           updated_at=now()
         RETURNING (xmax = 0) AS inserted`,
        [pack.id, i.sku, i.kind, i.title, Math.round(i.price), i.unit, i.tags, i.includes, i.enabled !== false, i.sort]);
      if (r[0]?.inserted) added += 1;
    }
    return { total: pack.catalog.length, added };
  },
  setPrice: (pack, sku, price) => db.q('UPDATE catalog SET price_rub=$3, updated_at=now() WHERE pack=$1 AND sku=$2', [pack, sku, Math.round(price)]),
  setEnabled: (pack, sku, on) => db.q('UPDATE catalog SET enabled=$3, updated_at=now() WHERE pack=$1 AND sku=$2', [pack, sku, Boolean(on)]),
};

module.exports = { deals, messages, drafts, followups, catalog, db, newId, ts };
