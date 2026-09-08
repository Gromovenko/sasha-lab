// Google Search Console API. Wordstat говорит, ЧТО ищут люди вообще;
// Search Console — по каким запросам показывают и куда кликают ИМЕННО этот сайт
// (показы, клики, средняя позиция). Это фактическая правда о выдаче, и она бесплатна.
// Доступ: сервисный аккаунт Google Cloud, JSON-ключ, аккаунт добавлен в GSC
// как пользователь ресурса sasha-lab.ru. Ключ — файл вне репозитория (GSC_KEY_FILE).
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

function keyfile() {
  const p = process.env.GSC_KEY_FILE;
  if (!p) throw new Error('нет GSC_KEY_FILE: путь к JSON-ключу сервисного аккаунта Google');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const b64url = (b) => Buffer.from(b).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function accessToken() {
  const sa = keyfile();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now,
  }));
  const sig = b64url(crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(sa.private_key));
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${header}.${claim}.${sig}`,
  }).toString();
  const r = await request('oauth2.googleapis.com', '/token', 'POST', body,
    { 'Content-Type': 'application/x-www-form-urlencoded' });
  if (!r.access_token) throw new Error(`Google не выдал токен: ${JSON.stringify(r).slice(0, 300)}`);
  return r.access_token;
}

function request(host, path, method, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path, method, headers: {
      ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) }, timeout: 60000 },
      (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => {
          const t = Buffer.concat(c).toString('utf8');
          if (res.statusCode >= 300) return reject(new Error(`${host}${path} → HTTP ${res.statusCode}: ${t.slice(0, 400)}`));
          try { resolve(JSON.parse(t)); } catch (e) { reject(new Error(`${host}${path} → не JSON`)); }
        });
      });
    req.on('timeout', () => req.destroy(new Error('таймаут 60 с')));
    req.on('error', reject);
    req.end(body);
  });
}

// Запросы сайта за период: [{ query, clicks, impressions, ctr, position }]
async function searchAnalytics({ site, startDate, endDate, dimensions = ['query'], rowLimit = 1000 } = {}) {
  const siteUrl = site || process.env.GSC_SITE || 'sc-domain:sasha-lab.ru';
  const token = await accessToken();
  const body = JSON.stringify({ startDate, endDate, dimensions, rowLimit });
  const r = await request('searchconsole.googleapis.com',
    `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    'POST', body, { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
  return (r.rows || []).map((row) => ({
    query: row.keys[0],
    clicks: row.clicks, impressions: row.impressions,
    ctr: row.ctr, position: row.position,
  }));
}

module.exports = { searchAnalytics, accessToken };
