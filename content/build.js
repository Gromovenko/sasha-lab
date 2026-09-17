#!/usr/bin/env node
// Генератор статических страниц базы знаний sasha-lab.
//
// Вход  — таблица materials (content/materials.js); на dev-копии без базы —
//          content/kb/*.md: одна страница = один файл с шапкой-метаданными.
// Выход — dist/: готовый статический HTML без единого запроса к базе,
//          плюс sitemap.xml и robots.txt. Ровно то, что просят поисковики:
//          быстрый семантический документ, а не div-каша конструктора.
//
// Почему не «форум с движком»: страница вопроса не меняется от посещения к
// посещению, значит генерировать её в рантайме незачем — и нечему падать.
const fs = require('fs');
const path = require('path');
// Доступы лежат в seo/.env вне git; ни pm2, ни голый node их сами не читают,
// а нужны они и серверу, и командам сборки — отсюда общий загрузчик.
require('../server-env')(require('path').join(__dirname, '..', 'seo', '.env'));
const materials = require('./materials');

const ROOT = path.join(__dirname, '..');
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
function layout({ url, title, description, breadcrumbs, body, jsonld, updated, noindex }) {
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
${noindex ? '<meta name="robots" content="noindex,follow">\n' : ''}<link rel="canonical" href="${SITE}${url}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${SITE}${url}">
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
const askLink = `<p class="asklink">Не нашли свой случай? <a href="/baza/vopros/">Задайте вопрос мастеру</a> — ответим и опубликуем ответ здесь.</p>`;

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
  <p class="meta">${meta.asker ? `Спрашивает ${esc(meta.asker)} · ` : ''}Отвечает мастер студии «Дядя Саша»${meta.updated ? ` · ${esc(meta.updated)}` : ''}</p>
  ${meta.question ? `<blockquote class="asked"><p>${esc(meta.question)}</p></blockquote>` : ''}
  <div class="answer">${html}</div>
  ${relatedBlock(related)}
  ${askLink}
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

// Приём вопросов от ЖИВЫХ посетителей. Это и есть «форум» из задачи, только
// без выдуманных участников: вопрос задаёт реальный человек, отвечает студия,
// ответ становится обычной статической страницей базы знаний. Форма без JS —
// обычный POST, чтобы работало везде и не тянуло скриптов на страницу.
function askPage() {
  const url = '/baza/vopros/';
  const body = `<article class="guide">
<h1>Задать вопрос мастеру</h1>
<p class="lead">Опишите, что со светом у вашей машины. Мы отвечаем сами, без
  «оставьте заявку» вместо ответа: разбор приходит вам и появляется в базе знаний,
  если вопрос пригодится другим.</p>
<form class="ask" method="POST" action="/baza/ask">
  <label>Как к вам обращаться<input name="name" maxlength="60" required autocomplete="name"></label>
  <label>Машина (марка, модель, год)<input name="car" maxlength="80" placeholder="Например: Toyota Camry XV50, 2014"></label>
  <label>Вопрос<textarea name="text" rows="7" minlength="20" maxlength="2000" required
    placeholder="Что происходит с фарами, что уже пробовали, чего хотите добиться"></textarea></label>
  <label>Телефон или почта для ответа<input name="contact" maxlength="80" required
    placeholder="+7 … или почта"></label>
  <label class="hp" aria-hidden="true">Не заполняйте это поле<input name="fax" tabindex="-1" autocomplete="off"></label>
  <label class="check"><input type="checkbox" name="agree" value="1" required>
    Согласен на обработку контакта для ответа — <a href="/privacypolicy">политика конфиденциальности</a></label>
  <button type="submit">Отправить вопрос</button>
</form>
<p class="note">Если ответ нужен срочно — звоните: <a href="tel:${BIZ.tel}">${BIZ.phone}</a>.
  Опубликуем только текст вопроса и имя; телефон и почта на сайт не попадают.</p>
</article>`;
  return { url, file: path.join('baza', 'vopros', 'index.html'),
    html: layout({ url, title: `Задать вопрос по автосвету мастеру — студия «Дядя Саша», ${BIZ.city}`,
      description: 'Задайте вопрос про фары, линзы, ремонт и полировку — мастер студии «Дядя Саша» в Ростове-на-Дону ответит лично.',
      breadcrumbs: [{ name: 'Главная', url: '/' }, { name: 'База знаний', url: '/baza/' }, { name: 'Задать вопрос' }],
      body, jsonld: [localBusiness] }) };
}

function errorPage() {
  const url = '/baza/vopros/oshibka/';
  const body = `<article class="guide">
<h1>Вопрос не отправился</h1>
<p class="lead">Такое бывает по двум причинам: не заполнено обязательное поле
  (имя, вопрос от 20 символов, контакт для ответа и согласие на обработку) —
  или с этого адреса за час уже ушло три вопроса.</p>
<p><a href="/baza/vopros/">Вернуться к форме</a>. Если проще сказать голосом —
  звоните: <a href="tel:${BIZ.tel}">${BIZ.phone}</a>.</p>
</article>`;
  return { url, file: path.join('baza', 'vopros', 'oshibka', 'index.html'), noindex: true,
    html: layout({ url, title: 'Вопрос не отправился — студия «Дядя Саша»', noindex: true,
      description: 'Форма вопроса не принята.',
      breadcrumbs: [{ name: 'Главная', url: '/' }, { name: 'База знаний', url: '/baza/' }, { name: 'Вопрос не отправился' }],
      body }) };
}

function thanksPage() {
  const url = '/baza/vopros/spasibo/';
  const body = `<article class="guide">
<h1>Вопрос принят</h1>
<p class="lead">Мастер посмотрит его и ответит на указанный контакт. Обычно это
  занимает рабочий день; если случай срочный — быстрее позвонить:
  <a href="tel:${BIZ.tel}">${BIZ.phone}</a>.</p>
<p><a href="/baza/">Вернуться в базу знаний</a></p>
</article>`;
  return { url, file: path.join('baza', 'vopros', 'spasibo', 'index.html'), noindex: true,
    html: layout({ url, title: 'Вопрос принят — студия «Дядя Саша»', noindex: true,
      description: 'Вопрос отправлен мастеру студии автосвета «Дядя Саша».',
      breadcrumbs: [{ name: 'Главная', url: '/' }, { name: 'База знаний', url: '/baza/' }, { name: 'Вопрос принят' }],
      body }) };
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

function rootIndex(byRubric, total, cars = []) {
  const sections = Object.keys(RUBRICS).filter((k) => byRubric[k] && byRubric[k].length).map((k) => {
    const r = RUBRICS[k];
    return `<section><h2><a href="/baza/${r.slug}/">${esc(r.title)}</a></h2><ul>${
      byRubric[k].slice(0, 8).map((d) => `<li><a href="/baza/${r.slug}/${d.meta.slug}/">${esc(d.meta.title)}</a></li>`).join('')
    }</ul></section>`;
  }).join('\n');
  const body = `<h1>База знаний по автосвету</h1>
<p class="lead">Вопросы, которые нам задают в мастерской, и честные ответы мастеров.
Без «оставьте заявку» вместо ответа. ${total} материалов.</p>
${askLink}
${cars.length ? `<section><h2><a href="/baza/avto/">Свет по машинам</a></h2>
<p>Что встаёт в фары конкретной модели: ${cars.slice(0, 6).map((v) =>
  `<a href="/baza/avto/${v.slug}/">${esc(capMake(v.make))} ${esc(capMake(v.model))}</a>`).join(', ')}
и ещё ${Math.max(0, cars.length - 6)}.</p></section>` : ''}
${sections}`;
  return { url: '/baza/', file: path.join('baza', 'index.html'),
    html: layout({ url: '/baza/', title: `База знаний по автосвету — студия «Дядя Саша», ${BIZ.city}`,
      description: 'Ответы мастеров по установке Bi-LED линз, ремонту, полировке и бронированию фар. Реальные вопросы клиентов студии в Ростове-на-Дону.',
      breadcrumbs: [{ name: 'Главная', url: '/' }, { name: 'База знаний' }],
      body, jsonld: [localBusiness] }) };
}

// ── сборка ─────────────────────────────────────────────────────────────────

// ── страницы по машинам ────────────────────────────────────────────────────
// Пункт задачи «статичные страницы с маркой авто и болью клиента». Ровно здесь
// проходит граница между полезной страницей и дорвеем, поэтому правило жёсткое:
// страница по машине рождается ТОЛЬКО когда о ней есть что сказать —
// подтверждённый студией факт или два независимых факта совместимости.
// Машина, про которую в базе одна строчка «где-то упоминалась», страницы не
// получает. Тысяча пустых страниц «линзы в <модель>» — это ровно тот
// scaled content abuse, из-за которого санкция прилетает на весь домен.
const MIN_FACTS = 2;

async function vehicleData() {
  const db = require('../seo/lib/db');
  if (!db.enabled) return [];
  // Второе условие — про рынок, а не про количество. С 17.09.2026 в базе есть
  // факты с англоязычного форума (hidplanet.com): знание оттуда ценное, но
  // страница студии в Ростове не должна РОЖДАТЬСЯ из одних заголовков
  // американского форума — там другой рынок и другие линзы, а проверить это
  // мастеру не по чему. Поэтому машина получает страницу, если её подтвердила
  // студия либо среди оснований есть хоть один русскоязычный документ.
  // У старых документов `lang` в meta нет — они считаются русскими.
  const rows = await db.q(`
    SELECT v.slug, v.make, v.model, v.year_from, v.year_to,
           json_agg(json_build_object('lens', f.lens, 'approach', f.approach,
             'headlight', f.headlight, 'hours', f.hours, 'notes', f.notes,
             'confidence', f.confidence, 'status', f.status)
             ORDER BY (f.status = 'confirmed') DESC, f.confidence DESC) AS fitment,
           count(*) FILTER (WHERE f.status = 'confirmed') AS confirmed,
           count(*) AS total
      FROM vehicles v JOIN fitment f ON f.vehicle_id = v.id
     GROUP BY v.id
    HAVING count(*) FILTER (WHERE f.status = 'confirmed') > 0
        OR (count(*) >= $1 AND bool_or(EXISTS (
              SELECT 1 FROM documents d
               WHERE d.id = ANY (f.evidence)
                 AND COALESCE(d.meta->>'lang', 'ru') = 'ru')))
     ORDER BY v.mentions DESC`, [MIN_FACTS]);
  return rows;
}

const capMake = (s) => String(s).split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const yearsOf = (v) => v.year_from ? `${v.year_from}${v.year_to && v.year_to !== v.year_from ? `–${v.year_to}` : ''}` : '';

function vehiclePage(v, docs) {
  const name = `${capMake(v.make)} ${capMake(v.model)}`;
  const years = yearsOf(v);
  const url = `/baza/avto/${v.slug}/`;
  const title = `Bi-LED линзы в ${name}${years ? ` ${years}` : ''}: что ставят и как`;
  const description = `Что встаёт в фары ${name}, нужно ли вскрывать фару и сколько это занимает — `
    + `по данным работ студии и открытых источников.`;
  const rows = (v.fitment || []).slice(0, 8).map((f) => `<tr><td>${esc(f.lens || '—')}</td>`
    + `<td>${esc(f.approach || 'не указан')}</td><td>${f.hours ? `${f.hours} ч` : '—'}</td>`
    + `<td>${f.status === 'confirmed' ? 'проверено студией' : 'по источникам'}</td></tr>`).join('\n');
  const related = pickRelated({ tags: ['линзы'], slug: v.slug, rubric: 'linzy' }, docs);
  const body = `<article>
<h1>${esc(title)}</h1>
<p class="lead">Владельцы ${esc(name)} приезжают с одним и тем же: фары светят тускло,
свет «размазан» по асфальту, встречные моргают. Ниже — что в эту фару физически
встаёт и чем отличаются варианты.</p>
<h2>Что ставят в фары ${esc(name)}</h2>
<table class="fit"><thead><tr><th>Линза / модуль</th><th>Способ</th><th>Работа</th><th>Откуда данные</th></tr></thead>
<tbody>${rows}</tbody></table>
<p class="note">Данные без пометки «проверено студией» собраны из открытых источников
и требуют осмотра конкретной фары: у одной модели за пару лет меняется и фара, и крепление.</p>
<h2>Вскрывать фару или нет</h2>
<p>Ответ зависит от того, что стоит с завода${docs.some((d) => d.meta.slug === 'ustanovka-linz-so-vskrytiem-fary')
    ? `. Разбор способов и последствий — в материале <a href="/baza/linzy/ustanovka-linz-so-vskrytiem-fary/">про установку со вскрытием</a>` : ''}.</p>
${relatedBlock(related)}
${askLink}
</article>`;
  return {
    url, file: path.join('baza', 'avto', v.slug, 'index.html'),
    html: layout({ url, title, description,
      breadcrumbs: [{ name: 'База знаний', url: '/baza/' }, { name: 'Машины', url: '/baza/avto/' }, { name: name }],
      body, jsonld: [localBusiness], updated: '' }),
  };
}

function vehicleIndex(list) {
  const url = '/baza/avto/';
  const items = list.map((v) => `<li><a href="/baza/avto/${v.slug}/">${esc(capMake(v.make))} `
    + `${esc(capMake(v.model))}${yearsOf(v) ? ` ${yearsOf(v)}` : ''}</a></li>`).join('\n');
  const body = `<article><h1>Свет по машинам</h1>
<p class="lead">Модели, по которым у нас накоплены проверяемые данные: что встаёт в фару,
нужно ли её вскрывать, сколько занимает работа.</p>
<ul class="list">${items}</ul>${askLink}</article>`;
  return { url, file: path.join('baza', 'avto', 'index.html'),
    html: layout({ url, title: 'Свет по маркам и моделям — база знаний «Дядя Саша»',
      description: 'Что встаёт в фары конкретной машины: линзы, способ установки, нюансы.',
      breadcrumbs: [{ name: 'База знаний', url: '/baza/' }, { name: 'Машины' }], body }) };
}

async function build() {
  const docs = await materials.load();
  for (const d of docs) {
    if (!RUBRICS[d.meta.rubric]) throw new Error(`${d.meta.slug}: неизвестная рубрика "${d.meta.rubric}"`);
  }

  const seen = new Set();
  for (const d of docs) {
    const k = `${d.meta.rubric}/${d.meta.slug}`;
    if (seen.has(k)) throw new Error(`дубль адреса: ${k}`);
    seen.add(k);
  }

  const byRubric = {};
  for (const d of docs) (byRubric[d.meta.rubric] ||= []).push(d);

  // Машины считаем до сборки индексов: корневая страница базы знаний должна
  // ссылаться на раздел, иначе он живёт только в sitemap и его никто не обходит.
  const cars = await vehicleData();

  const pages = [];
  for (const d of docs) pages.push(d.meta.type === 'guide' ? guidePage(d, docs) : questionPage(d, docs));
  for (const k of Object.keys(byRubric)) pages.push(rubricIndex(k, byRubric[k]));
  pages.push(rootIndex(byRubric, docs.length, cars));
  // Машины: страница появляется только там, где есть факты (см. MIN_FACTS).
  if (cars.length) {
    for (const v of cars) pages.push(vehiclePage(v, docs));
    pages.push(vehicleIndex(cars));
  }
  pages.push(askPage());
  pages.push(thanksPage());
  pages.push(errorPage());

  // Внутренние ссылки проверяем ДО записи: битая перелинковка — это не косметика,
  // именно по ней поисковик обходит базу знаний, и 404 внутри неё стоит дорого.
  const known = new Set(pages.map((p) => p.url).concat(['/baza/style.css']));
  const bad = [];
  for (const p of pages) {
    for (const m of p.html.matchAll(/href="(\/baza\/[^"]*)"/g)) {
      if (!known.has(m[1])) bad.push(`${p.url} → ${m[1]}`);
    }
  }
  if (bad.length) throw new Error('битые внутренние ссылки:\n  ' + [...new Set(bad)].join('\n  '));

  // Собираем в сторонний каталог и подменяем готовое одним движением. Иначе
  // упавшая на середине сборка (а её теперь запускает панель по кнопке
  // «опубликовать») оставляет живой сайт с пустым /baza — то же правило, по
  // которому нельзя потрошить .next работающего процесса.
  const TMP = OUT + '.tmp';
  fs.rmSync(TMP, { recursive: true, force: true });
  for (const p of pages) {
    const dest = path.join(TMP, p.file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, p.html);
  }
  fs.copyFileSync(path.join(__dirname, 'style.css'), path.join(TMP, 'baza', 'style.css'));

  const now = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(TMP, 'sitemap-baza.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    pages.filter((p) => !p.noindex)
      .map((p) => `  <url><loc>${SITE}${p.url}</loc><lastmod>${now}</lastmod></url>`).join('\n') +
    `\n</urlset>\n`);

  // Карта покрытия: какие поисковые запросы закрыты какой страницей.
  fs.writeFileSync(path.join(TMP, 'coverage.json'), JSON.stringify(docs.map((d) => ({
    url: `/baza/${RUBRICS[d.meta.rubric].slug}/${d.meta.slug}/`,
    title: d.meta.title, rubric: d.meta.rubric, queries: d.meta.queries,
  })), null, 2));

  const OLD = OUT + '.old';
  fs.rmSync(OLD, { recursive: true, force: true });
  if (fs.existsSync(OUT)) fs.renameSync(OUT, OLD);
  fs.renameSync(TMP, OUT);
  fs.rmSync(OLD, { recursive: true, force: true });

  console.log(`собрано ${pages.length} страниц из ${docs.length} материалов → dist/`);
  return pages;
}

if (require.main === module) {
  build()
    .then(() => require('../seo/lib/db').enabled && require('../seo/lib/db').close())
    .catch((e) => { console.error('сборка упала:', e.message); process.exit(1); });
}
module.exports = { build, RUBRICS, SITE };
