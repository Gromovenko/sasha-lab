// Ручки ассистента и страница «Помощник» базы знаний.
//
// Страница сознательно отдаётся приложением, а не собирается в статику: у неё
// нет постоянного содержимого, индексировать её нечем и незачем (X-Robots-Tag
// noindex). В индекс идут материалы /baza/, а ассистент — инструмент для живого
// человека и поставщик тем для этих материалов.
const assistant = require('./assistant');

const RATE = new Map();               // ip → [метки времени]
const RATE_MAX = 20;                  // вопросов в час с адреса
const HOUR = 3600_000;

function rateOk(ip) {
  const now = Date.now();
  const list = (RATE.get(ip) || []).filter((t) => now - t < HOUR);
  list.push(now);
  RATE.set(ip, list);
  if (RATE.size > 5000) RATE.clear();  // защита от роста памяти, точность здесь не нужна
  return list.length <= RATE_MAX;
}

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
  res.end(body);
};

function readJson(req, limit = 32 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => { size += d.length; if (size > limit) return req.destroy(); chunks.push(d); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(raw)); }
      catch { resolve(Object.fromEntries(new URLSearchParams(raw))); }
    });
    req.on('error', () => resolve({}));
  });
}

const ipOf = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  || req.socket.remoteAddress || '';

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (p === '/baza/pomoshnik') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow' });
    res.end(PAGE);
    return true;
  }

  if (p === '/baza/assistant' && req.method === 'POST') {
    const ip = ipOf(req);
    if (!rateOk(ip)) return json(res, 429, { error: 'слишком много вопросов подряд, подождите' }), true;
    const body = await readJson(req);
    try {
      const r = await assistant.ask({
        text: body.text, mode: body.mode === 'pro' ? 'pro' : 'client',
        make: body.make, model: body.model, year: body.year,
        threadId: body.threadId, ip, ua: req.headers['user-agent'],
      });
      json(res, r.error ? 400 : 200, r);
    } catch (e) {
      console.error('ассистент:', e.message);
      json(res, 500, { error: 'ассистент временно недоступен' });
    }
    return true;
  }

  // Гайд установщика отдельной ручкой: марка/модель/год → факты без болтовни.
  if (p === '/baza/podbor' && req.method === 'GET') {
    try {
      const g = await assistant.guide({
        make: url.searchParams.get('make'), model: url.searchParams.get('model'),
        year: url.searchParams.get('year'), text: url.searchParams.get('q'),
      });
      json(res, 200, g);
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}

const PAGE = `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Помощник по автосвету — база знаний «Дядя Саша»</title>
<style>
 body{margin:0;background:#0e0f12;color:#e8e8ea;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
 .wrap{max-width:760px;margin:0 auto;padding:28px 18px 80px}
 h1{font-size:24px;margin:0 0 6px} .sub{color:#9a9aa2;margin:0 0 22px}
 .tabs{display:flex;gap:8px;margin-bottom:18px}
 .tab{flex:1;padding:11px;border:1px solid #2a2c33;border-radius:10px;background:#15171c;color:#c9c9d1;cursor:pointer;text-align:center}
 .tab.on{background:#f0b429;border-color:#f0b429;color:#191919;font-weight:600}
 .car{display:none;gap:8px;margin-bottom:12px} .car.on{display:flex}
 input,textarea{width:100%;box-sizing:border-box;background:#15171c;border:1px solid #2a2c33;border-radius:10px;color:#e8e8ea;padding:11px;font:inherit}
 textarea{min-height:88px;resize:vertical}
 button.send{margin-top:10px;padding:12px 20px;border:0;border-radius:10px;background:#f0b429;color:#191919;font:600 16px/1 inherit;cursor:pointer}
 .msg{margin:16px 0;padding:14px;border-radius:12px;background:#15171c;border:1px solid #23252c;white-space:pre-wrap}
 .msg.me{background:#1d2027;border-color:#2c3038}
 .src{margin-top:10px;font-size:14px;color:#9a9aa2} .src a{color:#f0b429}
 table{width:100%;border-collapse:collapse;margin-top:10px;font-size:14px}
 td,th{border-top:1px solid #23252c;padding:6px 4px;text-align:left}
 .note{color:#9a9aa2;font-size:14px;margin-top:22px}
</style></head><body><div class="wrap">
<h1>Помощник по автосвету</h1>
<p class="sub">Отвечает по базе знаний студии. Чего нет в базе — не выдумывает, а зовёт мастера.</p>
<div class="tabs">
  <div class="tab on" data-mode="client">Я владелец машины</div>
  <div class="tab" data-mode="pro">Я установщик</div>
</div>
<div class="car" id="car">
  <input id="make" placeholder="марка (Haval)"><input id="model" placeholder="модель (Jolion)"><input id="year" placeholder="год" style="max-width:90px">
</div>
<textarea id="text" placeholder="Опишите вопрос: что с фарами, что хочется получить"></textarea>
<button class="send" id="send">Спросить</button>
<div id="feed"></div>
<p class="note">Ответы собраны из открытых источников и опыта студии. Перед работой сверяйтесь с мастером: у одной модели за пару лет меняется фара.</p>
</div>
<script>
 let mode='client', threadId=null;
 const $=(id)=>document.getElementById(id);
 document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{
   document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));
   t.classList.add('on'); mode=t.dataset.mode;
   $('car').classList.toggle('on', mode==='pro');
   $('text').placeholder = mode==='pro'
     ? 'Что нужно: подбор линз, нюансы вскрытия, комплектующие'
     : 'Опишите вопрос: что с фарами, что хочется получить';
 });
 function add(cls, html){ const d=document.createElement('div'); d.className='msg '+cls; d.innerHTML=html; $('feed').appendChild(d); d.scrollIntoView({behavior:'smooth',block:'nearest'}); return d; }
 const esc=(s)=>String(s||'').replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
 $('send').onclick=async()=>{
   const text=$('text').value.trim(); if(text.length<5) return;
   add('me', esc(text)); $('text').value='';
   const wait=add('', 'Смотрю базу…');
   try{
     const r=await fetch('/baza/assistant',{method:'POST',headers:{'Content-Type':'application/json'},
       body:JSON.stringify({text,mode,threadId,make:$('make').value,model:$('model').value,year:$('year').value})});
     const j=await r.json();
     threadId=j.threadId||threadId;
     let h=esc(j.answer||j.error||'');
     if(j.fitment&&j.fitment.length){
       h+='<table><tr><th>линза</th><th>способ</th><th>увер.</th></tr>'+
         j.fitment.map(f=>'<tr><td>'+esc(f.lens)+'</td><td>'+esc(f.approach||'—')+'</td><td>'+(f.confirmed?'✓ студия':f.confidence)+'</td></tr>').join('')+'</table>';
     }
     if(j.parts&&j.parts.length){
       h+='<table><tr><th>комплектующее</th><th>цена</th></tr>'+
         j.parts.map(p=>'<tr><td><a href="'+esc(p.url)+'" target="_blank" rel="nofollow noopener">'+esc(p.name)+'</a></td><td>'+(p.price_rub?p.price_rub+' ₽':'—')+'</td></tr>').join('')+'</table>';
     }
     if(j.sources&&j.sources.length){
       h+='<div class="src">В базе знаний: '+j.sources.map(s=>'<a href="'+s.url+'">'+esc(s.title)+'</a>').join(' · ')+'</div>';
     }
     wait.innerHTML=h;
   }catch(e){ wait.textContent='Не получилось спросить: '+e.message; }
 };
 $('text').addEventListener('keydown',e=>{ if((e.metaKey||e.ctrlKey)&&e.key==='Enter') $('send').click(); });
</script></body></html>`;

module.exports = { handle };
