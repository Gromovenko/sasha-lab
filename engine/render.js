// Маленький шаблонизатор для текстов КП и писем. Своей строчкой, а не пакетом:
// зависимостей у проекта две с половиной, и тащить mustache ради двадцати строк
// нечестно. Поддержано ровно то, что нужно шаблону пакета:
//   {{поле}}            — подстановка (пустое, если нет);
//   {{#список}}…{{/}}   — повтор по массиву ({{.}} — сам элемент);
//   {{#флаг}}…{{/}}     — блок, если значение истинно;
//   {{^флаг}}…{{/}}     — блок, если пусто.
// Экранирования нет намеренно: текст уходит в мессенджер и письмо как есть,
// html-панель экранирует его сама у себя.

function parse(tpl) {
  const root = { children: [] };
  const stack = [root];
  const re = /\{\{([#^/]?)([\w.]+)\}\}/g;
  let last = 0;
  let m;
  while ((m = re.exec(tpl))) {
    const top = stack[stack.length - 1];
    const text = tpl.slice(last, m.index);
    if (text) top.children.push({ t: 'text', v: text });
    last = re.lastIndex;
    const [, sigil, name] = m;
    if (sigil === '#' || sigil === '^') {
      const node = { t: 'section', inverted: sigil === '^', name, children: [] };
      top.children.push(node);
      stack.push(node);
    } else if (sigil === '/') {
      const open = stack[stack.length - 1];
      if (stack.length < 2 || open.name !== name) throw new Error(`шаблон: {{/${name}}} без открытия`);
      stack.pop();
    } else {
      top.children.push({ t: 'var', name });
    }
  }
  const tail = tpl.slice(last);
  if (tail) stack[stack.length - 1].children.push({ t: 'text', v: tail });
  if (stack.length !== 1) throw new Error(`шаблон: не закрыт {{#${stack[stack.length - 1].name}}}`);
  return root;
}

function lookup(name, stack) {
  if (name === '.') return stack[stack.length - 1];
  const [head, ...rest] = name.split('.');
  for (let i = stack.length - 1; i >= 0; i--) {
    const ctx = stack[i];
    if (ctx && typeof ctx === 'object' && head in ctx) {
      let v = ctx[head];
      for (const k of rest) v = v == null ? v : v[k];
      return v;
    }
  }
  return undefined;
}

function renderNodes(nodes, stack) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') { out += n.v; continue; }
    if (n.t === 'var') {
      const v = lookup(n.name, stack);
      out += v == null || v === false ? '' : String(v);
      continue;
    }
    const v = lookup(n.name, stack);
    const empty = v == null || v === false || v === '' || (Array.isArray(v) && !v.length);
    if (n.inverted) { if (empty) out += renderNodes(n.children, stack); continue; }
    if (empty) continue;
    if (Array.isArray(v)) {
      for (const item of v) out += renderNodes(n.children, [...stack, item]);
    } else if (typeof v === 'object') {
      out += renderNodes(n.children, [...stack, v]);
    } else {
      out += renderNodes(n.children, stack);
    }
  }
  return out;
}

function render(tpl, ctx) {
  return renderNodes(parse(String(tpl || '')).children, [ctx || {}]);
}

// Схлопываем хвосты пустых строк: в шаблоне блоки разделены переводами строк, и
// когда блок не сработал, в тексте остаётся дыра в три пустые строки.
const tidy = (s) => String(s).replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

module.exports = { render, parse, tidy };
