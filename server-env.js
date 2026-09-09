// Чтение seo/.env. Файл вне git, pm2 и голый node такие файлы сами не читают,
// а нужен он и серверу, и командам сбора — поэтому один модуль на всех.
const fs = require('fs');
module.exports = function loadEnv(file) {
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const v = m[2].trim().replace(/^["']|["']$/g, '');
    if (v && !process.env[m[1]]) process.env[m[1]] = v;
  }
  return true;
};
