// Разбор XML-выдачи Яндекса (Search API v2, FORMAT_XML) без внешних зависимостей.
// Нужен минимум: по порядку — url документа, заголовок, домен. Этого хватает,
// чтобы посчитать позицию своего сайта и увидеть, кто стоит выше.

function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function strip(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : '';
}

// → [{ pos, url, domain, title, snippet }]
function parseResults(xml) {
  const out = [];
  const docs = xml.match(/<doc[\s>][\s\S]*?<\/doc>/g) || [];
  for (const d of docs) {
    const url = strip(tag(d, 'url'));
    if (!url) continue;
    let domain = strip(tag(d, 'domain'));
    if (!domain) { try { domain = new URL(url).hostname; } catch { domain = ''; } }
    out.push({
      pos: out.length + 1,
      url,
      domain: domain.replace(/^www\./, '').toLowerCase(),
      title: strip(tag(d, 'title')),
      snippet: strip(tag(d, 'passages') || tag(d, 'headline')),
    });
  }
  return out;
}

function parseError(xml) {
  const m = xml.match(/<error[^>]*>([\s\S]*?)<\/error>/);
  return m ? strip(m[1]) : null;
}

// Позиция домена в выдаче: номер первого документа этого домена, иначе null.
function positionOf(results, domain) {
  const want = String(domain).replace(/^www\./, '').toLowerCase();
  const hit = results.find((r) => r.domain === want || r.domain.endsWith('.' + want));
  return hit ? { pos: hit.pos, url: hit.url, title: hit.title } : null;
}

module.exports = { parseResults, parseError, positionOf };
