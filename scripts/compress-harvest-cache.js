#!/usr/bin/env node
// Пережимает несжатые .harvest-cache/**/*.html в .html.gz (mtime сохраняется —
// от него считается возраст кэша). Безопасно перезапускать и гонять рядом со
// сбором: файл заменяется атомарно, читатель понимает оба формата.
//   node scripts/compress-harvest-cache.js [--dry]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { CACHE } = require('../harvest/http');

const dry = process.argv.includes('--dry');
let files = 0, before = 0, after = 0;
for (const d of fs.readdirSync(CACHE)) {
  const dir = path.join(CACHE, d);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.html')) continue;
    const file = path.join(dir, f);
    const st = fs.statSync(file);
    const gz = zlib.gzipSync(fs.readFileSync(file), { level: 9 });
    files++; before += st.size; after += gz.length;
    if (dry) continue;
    const tmp = file + '.gz.tmp';
    fs.writeFileSync(tmp, gz);
    fs.utimesSync(tmp, st.atime, st.mtime);
    fs.renameSync(tmp, file + '.gz');
    fs.unlinkSync(file);
  }
}
console.log(`${dry ? '[dry] ' : ''}файлов ${files}: ${(before / 1e9).toFixed(2)} ГБ → ${(after / 1e9).toFixed(2)} ГБ`);
