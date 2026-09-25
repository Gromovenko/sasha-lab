#!/usr/bin/env node
// Обновляет карусель отзывов на /faroeb из виджета Яндекс.Карт (реальные отзывы, полные тексты).
// Запуск: node scripts/faroeb-reviews.js   (виджет отдаёт не более 5 свежих отзывов)
'use strict';
const fs = require('fs');
const path = require('path');

const ORG = '38789490071';
const LINK = `https://yandex.ru/maps/org/dyadya_sasha/${ORG}/reviews/`;
const FILE = path.join(__dirname, '..', 'mirror/sasha-lab.ru/faroeb/index.html');

const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function main() {
  const res = await fetch(`https://yandex.ru/maps-reviews-widget/${ORG}?comments`, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`виджет ответил ${res.status}`);
  const h = await res.text();
  const names = [...h.matchAll(/comment__name">(.*?)<\/p>/g)].map((m) => unescape(m[1]));
  const texts = [...h.matchAll(/comment__text">(.*?)<\/p>/gs)].map((m) => unescape(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim());
  const items = names.map((n, i) => ({ name: n, text: texts[i] })).filter((r) => r.name && r.text);
  if (!items.length) throw new Error('в виджете нет отзывов — файл не тронут');

  const cards = items.map((r, i) => `        <figure class="review-card" role="group" aria-roledescription="слайд" aria-label="${i + 1} из ${items.length}"><span class="review-mark" aria-hidden="true">“</span><blockquote><p>«${esc(r.text)}»</p></blockquote><figcaption><strong>${esc(r.name)}</strong><a href="${LINK}" target="_blank" rel="noopener noreferrer">Яндекс.Карты ↗</a></figcaption></figure>`).join('\n');
  let html = fs.readFileSync(FILE, 'utf8');
  html = html.replace(/(<div class="reviews-track"[^>]*>\n)[\s\S]*?(\n      <\/div>\n      <div class="review-controls")/, `$1${cards}$2`);
  html = html.replace(/(data-review-position[^>]*>)\d+ \/ \d+/, `$11 / ${items.length}`);
  html = html.replace('Фрагменты отзывов о мастерской «Дядя Саша». Полные тексты — на Яндекс.Картах.', 'Отзывы клиентов мастерской «Дядя Саша» с Яндекс.Карт.');
  fs.writeFileSync(FILE, html);
  console.log(`отзывов: ${items.length}`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
