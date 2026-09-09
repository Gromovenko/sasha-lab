// Клиенты Яндекса: Wordstat (частотность) и Search API v2 (выдача → позиции).
// Оба живут в Yandex AI Studio / Cloud, авторизация одна: Api-Key + folderId.
// Ключ и папка НЕ хранятся в репозитории — только в окружении (см. seo/.env.example).
const https = require('https');

const HOST = 'searchapi.api.cloud.yandex.net';

function creds() {
  const key = process.env.YANDEX_SEARCH_API_KEY || '';
  const folderId = process.env.YANDEX_FOLDER_ID || '';
  if (!key || !folderId) {
    throw new Error(
      'нет доступа к API Яндекса: задайте YANDEX_SEARCH_API_KEY и YANDEX_FOLDER_ID ' +
      '(сервисный аккаунт с ролью search-api.webSearch.user, см. seo/.env.example)');
  }
  return { key, folderId };
}

function post(pathname, body, key) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: HOST, path: pathname, method: 'POST',
      headers: {
        'Authorization': `Api-Key ${key}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          return reject(new Error(`${pathname} → HTTP ${res.statusCode}: ${text.slice(0, 400)}`));
        }
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error(`${pathname} → не JSON: ${text.slice(0, 200)}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${pathname} → таймаут 60 с`)));
    req.on('error', reject);
    req.end(payload);
  });
}

// ── Wordstat ───────────────────────────────────────────────────────────────
// Ростов-на-Дону = регион 39, Ростовская область = 11029 (Wordstat/geo Яндекса).
const ROSTOV = ['39'];

// Топ запросов, содержащих фразу, за последние 30 дней. Платно: 20 ₽ за вызов.
// Сервис отдаёт не больше 250 результатов, просить больше бессмысленно.
// → { totalCount, results:[{phrase,count}], associations:[{phrase,count}] }
async function wordstatTop(phrase, { regions = ROSTOV, numPhrases = 250, devices } = {}) {
  const { key, folderId } = creds();
  const body = { phrase, numPhrases, folderId };
  if (regions && regions.length) body.regions = regions;
  if (devices && devices.length) body.devices = devices;
  const r = await post('/v2/wordstat/topRequests', body, key);
  return {
    totalCount: Number(r.totalCount || 0),
    results: (r.results || []).map(normPhrase),
    associations: (r.associations || []).map(normPhrase),
  };
}

// Динамика частоты фразы по периодам (сезонность: «полировка фар» летом ≠ зимой).
async function wordstatDynamics(phrase, { regions = ROSTOV, fromDate, toDate, period = 'PERIOD_MONTHLY' } = {}) {
  const { key, folderId } = creds();
  const body = { phrase, folderId, period };
  if (regions && regions.length) body.regions = regions;
  if (fromDate) body.fromDate = fromDate;
  if (toDate) body.toDate = toDate;
  return post('/v2/wordstat/dynamics', body, key);
}

// Распределение по регионам — проверка, что спрос действительно местный.
async function wordstatRegions(phrase) {
  const { key, folderId } = creds();
  return post('/v2/wordstat/regionsDistribution', { phrase, folderId }, key);
}

function normPhrase(p) {
  return { phrase: String(p.phrase || '').trim(), count: Number(p.count || 0) };
}

// ── Search API v2: выдача ──────────────────────────────────────────────────
// Синхронный режим: ответ приходит сразу, rawData — XML в base64.
// Лимит синхронного режима — 1 запрос/с, поэтому позиции снимаем с паузой.
async function webSearch(queryText, { page = 0, region = '39', l10n = 'LOCALIZATION_RU' } = {}) {
  const { key, folderId } = creds();
  const body = {
    query: { searchType: 'SEARCH_TYPE_RU', queryText, page, familyMode: 'FAMILY_MODE_NONE' },
    sortSpec: { sortMode: 'SORT_MODE_BY_RELEVANCE' },
    groupSpec: { groupMode: 'GROUP_MODE_FLAT', groupsOnPage: 20, docsInGroup: 1 },
    responseFormat: 'FORMAT_XML',
    region: String(region),
    l10n,
    folderId,
  };
  const r = await post('/v2/web/search', body, key);
  const raw = r.rawData || '';
  // rawData приходит base64; на всякий случай терпим и голый XML.
  const xml = raw.trimStart().startsWith('<') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return xml;
}

module.exports = { wordstatTop, wordstatDynamics, wordstatRegions, webSearch, ROSTOV };
