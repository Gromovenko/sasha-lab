#!/usr/bin/env node
// Генератор статических страниц базы знаний sasha-lab.
//
// Вход  — content/kb/*.md: одна страница = один файл с шапкой-метаданными.
// Выход — dist/: готовый статический HTML без единого запроса к базе,
//          плюс sitemap.xml и robots.txt. Ровно то, что просят поисковики:
//          быстрый семантический документ, а не div-каша конструктора.
//
// Почему не «форум с движком»: страница вопроса не меняется от посещения к
// посещению, значит генерировать её в рантайме незачем — и нечему падать.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KB = path.join(__dirname, 'kb');
const OUT = path.join(ROOT, 'dist');
const SITE = process.env.SITE_ORIGIN || 'https://sasha-lab.ru';

const BIZ = {
  name: 'Студия автосвета «Дядя Саша»',
  phone: '+7 909 888-75-75',
  tel: '+79098887575',
  addr: 'Ростов-на-Дону, пр. Стачки, 68',
  city: 'Ростов-на-Дону',
  maps: 'https://yandex.ru/maps/org/dyadya_sasha/38789490071/',
};

const RUBRICS = {
  linzy:    { title: 'Линзы и Bi-LED', slug: 'linzy',    hub: '/ustanovka-linz' },
  remont:   { title: 'Ремонт фар',      slug: 'remont',   hub: '/remont-far' },
  polirovka:{ title: 'Полировка и защита', slug: 'polirovka', hub: '/fara' },
  zakon:    { title: 'Закон и техосмотр', slug: 'zakon',  hub: null },
  vybor:    { title: 'Выбор и эксплуатация', slug: 'vybor', hub: null },
};

// ── разбор исходников ──────────────────────────────────────────────────────
function parseFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error(`${path.basename(file)}: нет шапки --- ... ---`);
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else v = v.replace(/^["']|["']$/g, '');
    meta[kv[1]] = v;
  }
  meta.file = path.basename(file);
  if (!meta.slug) throw new Error(`${meta.file}: нет slug`);
  if (!meta.title) throw new Error(`${meta.file}: нет title`);
  if (!RUBRICS[meta.rubric]) throw new Error(`${meta.file}: неизвестная рубрика "${meta.rubric}"`);
  meta.type = meta.type || 'question';
  meta.tags = meta.tags || [];
  meta.queries = meta.queries || [];
  return { meta, body: m[2].trim() };
}

// ── микро-markdown (заголовки, списки, цитаты, ссылки, жирный) ─────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s) {
  return esc(s)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function markdown(src) {
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }
    let m;
    if ((m = line.match(/^(#{2,4})\s+(.*)$/))) {
      closeList();
      const lvl = m[1].length;
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
    } else if ((m = line.match(/^[-*]\s+(.*)$/))) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\d+\.\s+(.*)$/))) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      closeList();
      out.push(`<blockquote><p>${inline(m[1])}</p></blockquote>`);
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join('\n');
}

const plain = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// ── шаблон ─────────────────────────────────────────────────────────────────
function layout({ url, title, description, breadcrumbs, body, jsonld, updated }) {
  const crumbs = breadcrumbs.map((c, i) => c.url
    ? `<a href="${c.url}">${esc(c.name)}</a>`
    : `<span aria-current="page">${esc(c.name)}</span>`).join('<span class="sep">/</span>');
  const ld = [
    {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: breadcrumbs.map((c, i) => ({
        '@type': 'ListItem', position: i + 1, name: c.name,
        ...(c.url ? { item: SITE + c.url } : {}),
      })),
    },
    ...(jsonld || []),
  ];
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}${url}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${SITE}${url}">
<link rel="preconnect" href="/cdn">
<link rel="stylesheet" href="/baza/style.css">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
</head>
<body>
<header class="top">
  <a class="brand" href="/">Дядя Саша<span>студия автосвета · ${BIZ.city}</span></a>
  <nav class="topnav">
    <a href="/ustanovka-linz">Линзы</a>
    <a href="/remont-far">Ремонт фар</a>
    <a href="/fara">Полировка</a>
    <a href="/baza/">База знаний</a>
  </nav>
  <a class="call" href="tel:${BIZ.tel}">${BIZ.phone}</a>
</header>
<nav class="crumbs">${crumbs}</nav>
<main>
${body}
</main>
<aside class="cta">
  <h2>Нужен живой ответ по вашей машине?</h2>
  <p>Приезжайте на бесплатный осмотр или позвоните — посмотрим фару и скажем прямо,
     что с ней делать. ${esc(BIZ.addr)}.</p>
  <p><a class="btn" href="tel:${BIZ.tel}">${BIZ.phone}</a>
     <a class="btn ghost" href="${BIZ.maps}" rel="nofollow noopener" target="_blank">Как проехать</a></p>
</aside>
<footer>
  <p>${esc(BIZ.name)} · ${esc(BIZ.addr)} · <a href="tel:${BIZ.tel}">${BIZ.phone}</a></p>
  ${updated ? `<p class="upd">Материал обновлён: ${esc(updated)}</p>` : ''}
  <p><a href="/privacypolicy">Политика конфиденциальности</a></p>
</footer>
</body>
</html>
`;
}

const localBusiness = {
  '@context': 'https://schema.org', '@type': 'AutoRepair',
  name: BIZ.name, telephone: BIZ.tel, url: SITE, sameAs: [BIZ.maps],
  address: { '@type': 'PostalAddress', addressLocality: BIZ.city, streetAddress: 'пр. Стачки, 68', addressCountry: 'RU' },
  areaServed: { '@type': 'City', name: BIZ.city },
};

// ── страницы ───────────────────────────────────────────────────────────────
function questionPage(doc, all) {
  const { meta, body } = doc;
  const html = markdown(body);
  const answerText = plain(html).slice(0, 5000);
  const related = pickRelated(meta, all);
  const url = `/baza/${RUBRICS[meta.rubric].slug}/${meta.slug}/`;
  const desc = meta.description || answerText.slice(0, 180);
  const jsonld = [{
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: [{
      '@type': 'Question', name: meta.title,
      acceptedAnswer: { '@type': 'Answer', text: answerText },
    }],
  }, localBusiness];
  const bodyHtml = `
<article class="q">
  <h1>${esc(meta.title)}</h1>
  <p class="meta">Отвечает мастер студии «Дядя Саша»${meta.updated ? ` · ${esc(meta.updated)}` : ''}</p>
  <div class="answer">${html}</div>
  ${relatedBlock(related)}
</article>`;
  return { url, file: path.join('baza', RUBRICS[meta.rubric].slug, meta.slug, 'index.html'),
    html: layout({ url, title: meta.title, description: desc,
      breadcrumbs: crumbsFor(meta), body: bodyHtml, jsonld, updated: meta.updated }) };
}

function guidePage(doc, all) {
  const { meta, body } = doc;
  const html = markdown(body);
  const url = `/baza/${RUBRICS[meta.rubric].slug}/${meta.slug}/`;
  const desc = meta.description || plain(html).slice(0, 180);
  const bodyHtml = `
<article class="guide">
  <h1>${esc(meta.title)}</h1>
  <p class="meta">Студия автосвета «Дядя Саша», ${BIZ.city}${meta.updated ? ` · ${esc(meta.updated)}` : ''}</p>
  ${html}
  ${relatedBlock(pickRelated(meta, all))}
</article>`;
  return { url, file: path.join('baza', RUBRICS[meta.rubric].slug, meta.slug, 'index.html'),
    html: layout({ url, title: meta.title, description: desc, breadcrumbs: crumbsFor(meta),
      body: bodyHtml, updated: meta.updated,
      jsonld: [{ '@context': 'https://schema.org', '@type': 'Article', headline: meta.title,
        author: { '@type': 'Organization', name: BIZ.name }, publisher: { '@type': 'Organization', name: BIZ.name },
        dateModified: meta.updated || undefined }, localBusiness] }) };
}

function crumbsFor(meta) {
  const r = RUBRICS[meta.rubric];
  return [
    { name: 'Главная', url: '/' },
    { name: 'База знаний', url: '/baza/' },
    { name: r.title, url: `/baza/${r.slug}/` },
    { name: meta.title },
  ];
}

function pickRelated(meta, all) {
  const tags = new Set(meta.tags);
  return all
    .filter((d) => d.meta.slug !== meta.slug)
    .map((d) => ({ d, score: (d.meta.rubric === meta.rubric ? 1 : 0) + d.meta.tags.filter((t) => tags.has(t)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.d);
}

function relatedBlock(list) {
  if (!list.length) return '';
  return `<section class="related"><h2>Об этом же</h2><ul>${list.map((d) =>
    `<li><a href="/baza/${RUBRICS[d.meta.rubric].slug}/${d.meta.slug}/">${esc(d.meta.title)}</a></li>`).join('')}</ul></section>`;
}

function rubricIndex(key, docs) {
  const r = RUBRICS[key];
  const url = `/baza/${r.slug}/`;
  const items = docs.map((d) => `<li><a href="/baza/${r.slug}/${d.meta.slug}/">${esc(d.meta.title)}</a>
    ${d.meta.description ? `<span>${esc(d.meta.description)}</span>` : ''}</li>`).join('\n');
  const body = `<h1>${esc(r.title)} — вопросы и разборы</h1>
${r.hub ? `<p class="lead">Услуга целиком: <a href="${r.hub}">${esc(r.title.toLowerCase())} в ${BIZ.city}</a>.</p>` : ''}
<ul class="cards">${items}</ul>`;
  return { url, file: path.join('baza', r.slug, 'index.html'),
    html: layout({ url, title: `${r.title}: вопросы и ответы — студия «Дядя Саша», ${BIZ.city}`,
      description: `Разборы и ответы мастеров по теме «${r.title.toLowerCase()}»: ${docs.length} материалов.`,
      breadcrumbs: [{ name: 'Главная', url: '/' }, { name: 'База знаний', url: '/baza/' }, { name: r.title }],
      body, jsonld: [localBusiness] }) };
}

function rootIndex(byRubric, total) {
  const sections = Object.keys(RUBRICS).filter((k) => byRubric[k] && byRubric[k].length).map((k) => {
    const r = RUBRICS[k];
    return `<section><h2><a href="/baza/${r.slug}/">${esc(r.title)}</a></h2><ul>${
      byRubric[k].slice(0, 8).map((d) => `<li><a href="/baza/${r.slug}/${d.meta.slug}/">${esc(d.meta.title)}</a></li>`).join('')
    }</ul></section>`;
  }).join('\n');
  const body = `<h1>База знаний по автосвету</h1>
<p class="lead">Вопросы, которые нам задают в мастерской, и честные ответы мастеров.
Без «оставьте заявку» вместо ответа. ${total} материалов.</p>
${sections}`;
  return { url: '/baza/', file: path.join('baza', 'index.html'),
    html: layout({ url: '/baza/', title: `База знаний по автосвету — студия «Дядя Саша», ${BIZ.city}`,
      description: 'Ответы мастеров по установке Bi-LED линз, ремонту, полировке и бронированию фар. Реальные вопросы клиентов студии в Ростове-на-Дону.',
      breadcrumbs: [{ name: 'Главная', url: '/' }, { name: 'База знаний' }],
      body, jsonld: [localBusiness] }) };
}

// ── сборка ─────────────────────────────────────────────────────────────────
function build() {
  const files = fs.existsSync(KB) ? fs.readdirSync(KB).filter((f) => f.endsWith('.md')) : [];
  const docs = files.map((f) => parseFile(path.join(KB, f)));

  const seen = new Set();
  for (const d of docs) {
    const k = `${d.meta.rubric}/${d.meta.slug}`;
    if (seen.has(k)) throw new Error(`дубль адреса: ${k}`);
    seen.add(k);
  }

  const byRubric = {};
  for (const d of docs) (byRubric[d.meta.rubric] ||= []).push(d);

  const pages = [];
  for (const d of docs) pages.push(d.meta.type === 'guide' ? guidePage(d, docs) : questionPage(d, docs));
  for (const k of Object.keys(byRubric)) pages.push(rubricIndex(k, byRubric[k]));
  pages.push(rootIndex(byRubric, docs.length));

  fs.rmSync(OUT, { recursive: true, force: true });
  for (const p of pages) {
    const dest = path.join(OUT, p.file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, p.html);
  }
  fs.copyFileSync(path.join(__dirname, 'style.css'), path.join(OUT, 'baza', 'style.css'));

  // Внутренние ссылки проверяем на месте: битая перелинковка — это не косметика,
  // именно по ней поисковик обходит базу знаний, и 404 внутри неё стоит дорого.
  const known = new Set(pages.map((p) => p.url).concat(['/baza/style.css']));
  const bad = [];
  for (const p of pages) {
    for (const m of p.html.matchAll(/href="(\/baza\/[^"]*)"/g)) {
      if (!known.has(m[1])) bad.push(`${p.url} → ${m[1]}`);
    }
  }
  if (bad.length) throw new Error('битые внутренние ссылки:\n  ' + [...new Set(bad)].join('\n  '));

  const now = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(OUT, 'sitemap-baza.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    pages.map((p) => `  <url><loc>${SITE}${p.url}</loc><lastmod>${now}</lastmod></url>`).join('\n') +
    `\n</urlset>\n`);

  // Карта покрытия: какие поисковые запросы закрыты какой страницей.
  fs.writeFileSync(path.join(OUT, 'coverage.json'), JSON.stringify(docs.map((d) => ({
    url: `/baza/${RUBRICS[d.meta.rubric].slug}/${d.meta.slug}/`,
    title: d.meta.title, rubric: d.meta.rubric, queries: d.meta.queries,
  })), null, 2));

  console.log(`собрано ${pages.length} страниц из ${docs.length} материалов → dist/`);
  return pages;
}

if (require.main === module) {
  try { build(); } catch (e) { console.error('сборка упала:', e.message); process.exit(1); }
}
module.exports = { build, RUBRICS, SITE };
