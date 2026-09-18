// Доставка писем учётной записи: ссылка на смену пароля и приглашение.
//
// Каналов у студии несколько и они настраиваются по одному (см. engine/channels):
// почта Resend, СМС, телеграм. Поэтому здесь не «почтовый модуль», а лестница:
// берём первый канал, для которого есть и адрес человека, и ключи. Ничего не
// настроено — честно возвращаем ok:false, и вызывающий кладёт ссылку в лог
// процесса, откуда её достанет владелец (`node admin/cli.js reset-link`).
const channels = require('../engine/channels');

const STUDIO = () => process.env.STUDIO_TITLE || 'Дядя Саша · автосвет';

function routes(user) {
  const out = [];
  if (user.email) out.push({ id: 'email', to: user.email });
  if (user.phone) out.push({ id: 'sms', to: user.phone }, { id: 'whatsapp', to: user.phone });
  const tg = user.meta && (user.meta.telegram_chat_id || user.meta.telegram);
  if (tg) out.unshift({ id: 'telegram', to: tg });
  return out;
}

async function deliver(user, { subject, text, short }) {
  const tried = [];
  for (const r of routes(user)) {
    const ch = channels.get(r.id);
    if (!ch.configured()) { tried.push(`${r.id}: нет ключей`); continue; }
    const res = await ch.send({ to: r.to, subject, text: r.id === 'sms' ? (short || text) : text });
    if (res.ok && !res.manual) return { ok: true, via: r.id, tried };
    tried.push(`${r.id}: ${res.error || 'не ушло'}`);
  }
  return { ok: false, via: null, error: tried.join('; ') || 'у человека нет ни почты, ни телефона', tried };
}

const resetLink = ({ user, link, minutes }) => deliver(user, {
  subject: `Смена пароля · ${STUDIO()}`,
  text: `Здравствуйте${user.name ? `, ${user.name}` : ''}!\n\nВы (или кто-то от вашего имени) попросили сменить пароль.\nСсылка действует ${minutes} мин и сработает один раз:\n\n${link}\n\nЕсли это были не вы — просто не переходите по ссылке, пароль останется прежним.\n\n${STUDIO()}`,
  short: `Смена пароля: ${link} (действует ${minutes} мин)`,
});

const invite = ({ user, link }) => deliver(user, {
  subject: `Доступ в кабинет · ${STUDIO()}`,
  text: `Здравствуйте${user.name ? `, ${user.name}` : ''}!\n\nДля вас открыт личный кабинет: там видно ваши заявки, расчёты и переписку.\nЗадайте пароль по ссылке:\n\n${link}\n\n${STUDIO()}`,
  short: `Кабинет ${STUDIO()}: задайте пароль ${link}`,
});

module.exports = { resetLink, invite, deliver, routes };
