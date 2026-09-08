// Яндекс.Вебмастер API v4 — то же, что Search Console, но для Яндекса:
// показы/клики/средняя позиция по реальным запросам сайта плюс состояние индексации.
// Доступ: OAuth-токен пользователя-владельца сайта (YANDEX_WEBMASTER_TOKEN).
const https = require('https');

function get(path) {
  const token = process.env.YANDEX_WEBMASTER_TOKEN;
  if (!token) throw new Error('нет YANDEX_WEBMASTER_TOKEN (OAuth-токен владельца сайта)');
  return new Promise((resolve, reject) => {
    const req = https.request({ host: 'api.webmaster.yandex.net', path, method: 'GET',
      headers: { Authorization: `OAuth ${token}` }, timeout: 60000 }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => {
        const t = Buffer.concat(c).toString('utf8');
        if (res.statusCode >= 300) return reject(new Error(`webmaster ${path} → HTTP ${res.statusCode}: ${t.slice(0, 300)}`));
        try { resolve(JSON.parse(t)); } catch { reject(new Error('webmaster → не JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('таймаут 60 с')));
    req.on('error', reject);
    req.end();
  });
}

async function userId() {
  return (await get('/v4/user/')).user_id;
}

// host_id вида "https:sasha-lab.ru:443"
async function hostId(domain = 'sasha-lab.ru') {
  const uid = await userId();
  const hosts = (await get(`/v4/user/${uid}/hosts/`)).hosts || [];
  const h = hosts.find((x) => (x.ascii_host_url || '').includes(domain));
  if (!h) throw new Error(`сайт ${domain} не найден в Вебмастере этого аккаунта`);
  return { uid, hostId: h.host_id };
}

// Популярные запросы сайта: [{ query, shows, clicks, position, ctr }]
async function searchQueries({ domain = 'sasha-lab.ru', dateFrom, dateTo, device = 'ALL' } = {}) {
  const { uid, hostId: hid } = await hostId(domain);
  const qs = new URLSearchParams({
    order_by: 'TOTAL_SHOWS', device_type_indicator: device,
    date_from: dateFrom, date_to: dateTo, limit: '500',
  });
  for (const i of ['TOTAL_SHOWS', 'TOTAL_CLICKS', 'AVG_SHOW_POSITION', 'AVG_CLICK_POSITION'])
    qs.append('query_indicator', i);
  const r = await get(`/v4/user/${uid}/hosts/${encodeURIComponent(hid)}/search-queries/popular/?${qs}`);
  return (r.queries || []).map((q) => ({
    query: q.query_text,
    shows: q.indicators?.TOTAL_SHOWS ?? 0,
    clicks: q.indicators?.TOTAL_CLICKS ?? 0,
    position: q.indicators?.AVG_SHOW_POSITION ?? null,
  }));
}

module.exports = { searchQueries, hostId, userId };
