// Учётка клиента заводится сама в момент заявки.
//
// Так сделано, чтобы у кабинета не было отдельной «регистрации ради регистрации»:
// человек уже оставил телефон или почту — этого достаточно, чтобы завести
// запись без пароля («приглашён»). Дальше он либо получает ссылку от мастера,
// либо сам жмёт «забыли пароль» и попадает в свои заявки. Ничего лишнего у него
// не спрашивают второй раз.
const defaultStore = require('./store');
const log = require('./log');

// Заявка без контакта (бывает: человек написал в чат площадки) кабинет не
// получает — привязывать нечего и высылать некуда.
async function ensureForDeal(deal, { store = defaultStore } = {}) {
  const contact = String(deal.client_contact || '').trim();
  if (!contact) return null;
  const isEmail = contact.includes('@');
  const email = isEmail ? contact : null;
  const phone = isEmail ? null : contact;
  if (!store.norm.email(email) && !store.norm.phone(phone)) return null;
  try {
    let u = await store.users.byLogin(contact);
    if (!u) {
      u = await store.users.create({ email, phone, name: deal.client_name || null, role: 'client' });
      await log.info({ area: 'cabinet', action: 'client.auto', userId: u.id, actor: contact,
        entity: 'deal', entityId: deal.id, message: 'учётка клиента заведена по заявке' }, { store });
    }
    await store.clientDeals.attach(deal.id, u.id);
    return u;
  } catch (e) {
    // Гонка двух заявок с одного телефона или блокировка базы не должны ломать
    // приём заявки: кабинет — приятное дополнение, заявка — деньги.
    await log.warn({ area: 'cabinet', action: 'client.auto.fail', entity: 'deal', entityId: deal.id, message: e.message }, { store });
    return null;
  }
}

// Привязка уже существующих заявок к учётке — при регистрации и первом входе.
async function attachDeals(user, { store = defaultStore } = {}) {
  const deals = await store.clientDeals.list(user, 100);
  let n = 0;
  for (const d of deals) if (!d.client_user_id) { await store.clientDeals.attach(d.id, user.id); n += 1; }
  return n;
}

module.exports = { ensureForDeal, attachDeals };
