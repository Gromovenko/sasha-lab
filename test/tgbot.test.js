// Бот приёма файлов: имя файла и папка приходят из чужого ввода, поэтому
// проверяется главное — путь не выходит из папки загрузок, а альбом/фото
// выбираются корректно.
const test = require('node:test');
const assert = require('node:assert');
const { safeName, safeCat, catFromCaption, pickMedia } = require('../scripts/tg-upload-bot.js');

test('имя файла не может выйти из папки', () => {
  assert.strictEqual(safeName('../../etc/passwd', 'x'), 'passwd');
  assert.strictEqual(safeName('..', 'x'), 'x');
  assert.strictEqual(safeName('.env', 'x'), 'env');
  assert.strictEqual(safeName('фото линзы (1).jpg', 'x'), 'фото линзы _1_.jpg');
});

test('папка из хэштега очищается', () => {
  assert.strictEqual(catFromCaption('для фида #Feed'), 'feed');
  assert.strictEqual(catFromCaption('#образцы'), 'образцы');
  assert.strictEqual(catFromCaption('без тега'), null);
  assert.strictEqual(safeCat('../x'), 'x');
  assert.strictEqual(safeCat('///'), null);
});

test('из фото берётся самый крупный размер', () => {
  const m = { photo: [{ file_id: 'a', file_size: 10 }, { file_id: 'b', file_size: 900 }, { file_id: 'c', file_size: 100 }] };
  assert.strictEqual(pickMedia(m).id, 'b');
  assert.strictEqual(pickMedia({ text: 'hi' }), null);
  assert.strictEqual(pickMedia({ document: { file_id: 'd', file_name: 'a.xml', file_size: 5 } }).name, 'a.xml');
});
