import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGameInfo, joinNames, parseRequirements, parsePcRequirements, htmlToText, shortDescription, aboutText, decodeEntities } from '../server/lib/steamParse.js';

// Bentuk umum Steam: <ul class="bb_ul"><li><strong>OS *:</strong> ...
const UL = '<strong>Minimum:</strong><br><ul class="bb_ul"><li><strong>OS *:</strong> Windows 10 64-bit<br></li><li><strong>Processor:</strong> Intel Core i5-8400 / AMD Ryzen 5 1600<br></li><li><strong>Memory:</strong> 8 GB RAM<br></li><li><strong>Graphics:</strong> NVIDIA GTX 1060 6GB<br></li><li><strong>DirectX:</strong> Version 12<br></li><li><strong>Storage:</strong> 50 GB available space<br></li><li><strong>Additional Notes:</strong> SSD recommended</li></ul>';

test('requirements: bentuk <ul><li><strong>', () => {
  const { rows } = parseRequirements(UL);
  assert.deepEqual(rows.map((r) => r.label), ['OS', 'Processor', 'Memory', 'Graphics', 'DirectX', 'Storage', 'Additional Notes']);
  assert.equal(rows[0].value, 'Windows 10 64-bit');
  assert.equal(rows[1].value, 'Intel Core i5-8400 / AMD Ryzen 5 1600');
  assert.equal(rows[4].value, 'Version 12');
});

test('requirements: teks datar dipisah <br> dan entitas HTML', () => {
  const { rows } = parseRequirements('Minimum:<br>OS: Windows&nbsp;7 &amp; later<br>Processor: 2.0 GHz Dual Core<br>Memory: 4&nbsp;GB RAM<br>Hard Drive: 10 GB');
  assert.deepEqual(rows, [
    { label: 'OS', value: 'Windows 7 & later' },
    { label: 'Processor', value: '2.0 GHz Dual Core' },
    { label: 'Memory', value: '4 GB RAM' },
    { label: 'Hard Drive', value: '10 GB' },
  ]);
});

test('requirements: nilai tidak diubah, field kosong tidak dikarang', () => {
  const { rows, dropped } = parseRequirements('<ul><li><strong>OS:</strong> Windows 11</li><li><strong>Graphics:</strong> </li></ul>');
  assert.deepEqual(rows, [{ label: 'OS', value: 'Windows 11' }]);
  assert.equal(dropped, 1);
});

test('requirements: lanjutan baris & catatan tanpa label', () => {
  const { rows } = parseRequirements('OS: Windows 10<br>Graphics: GTX 970<br>or equivalent<br>* Requires 64-bit processor');
  assert.equal(rows[1].value, 'GTX 970 or equivalent');
  assert.deepEqual(rows[2], { label: 'Notes', value: 'Requires 64-bit processor' });
});

test('requirements: kosong / array kosong / bukan string', () => {
  assert.deepEqual(parseRequirements('').rows, []);
  assert.deepEqual(parseRequirements(undefined).rows, []);
  assert.deepEqual(parseRequirements([]).rows, []);
  const pc = parsePcRequirements([]);            // Steam mengirim [] untuk game tanpa persyaratan
  assert.deepEqual([pc.min.rows, pc.rec.rows], [[], []]);
  const only = parsePcRequirements({ minimum: UL });
  assert.equal(only.min.rows.length, 7);
  assert.equal(only.rec.rows.length, 0);
});

test('requirements: batas skema (label 60, nilai 200, 20 baris)', () => {
  const long = 'x'.repeat(500);
  const r = parseRequirements(`OS: ${long}`);
  assert.ok(r.rows[0].value.length <= 200);
  assert.equal(r.truncated, 1);
  const many = Array.from({ length: 30 }, (_, i) => `Item${i}: v${i}`).join('<br>');
  assert.equal(parseRequirements(many).rows.length, 20);
});

test('htmlToText: tag, script, entitas, karakter aneh, baris berlebih', () => {
  const t = htmlToText('<p>Halo&nbsp;dunia</p><script>alert(1)</script><p></p><p></p><p>Baris&#8217;dua\u200b &lt;b&gt;</p>');
  assert.equal(t, 'Halo dunia\n\nBaris’dua <b>');
  assert.equal(decodeEntities('&#x41;&#66;&unknown;'), 'AB&unknown;');
  assert.equal(htmlToText(null), '');
});

test('deskripsi: ringkas <=300, lengkap <=4000, dipotong di batas kalimat', () => {
  const s = shortDescription('<b>A</b> '.repeat(200));
  assert.ok(s.text.length <= 300 && s.truncated);
  assert.ok(!/<|>/.test(s.text));
  const sentence = 'Kalimat contoh yang cukup panjang untuk uji. ';
  const a = aboutText(`<p>${sentence.repeat(200)}</p>`);
  assert.ok(a.text.length <= 4000 && a.truncated && a.text.endsWith('.'));
  assert.equal(aboutText('').text, '');
});

test('game info: developer, publisher, rilis, genre, kategori, Metacritic dari appdetails', () => {
  const i = parseGameInfo({
    developers: ['Studio A', 'Studio A', ' '], publishers: ['Pub &amp; Co'],
    release_date: { coming_soon: false, date: '10 Jul, 2020' },
    genres: [{ id: '1', description: 'Action' }, { id: '25', description: 'Adventure' }],
    categories: [{ id: 2, description: 'Single-player' }],
    metacritic: { score: 91, url: 'https://www.metacritic.com/game/x' },
    website: 'javascript:alert(1)',
  });
  assert.deepEqual(i.developers, ['Studio A']);
  assert.equal(i.publisher, 'Pub & Co');
  assert.equal(i.releaseDate, '10 Jul, 2020');
  assert.deepEqual(i.genres, ['Action', 'Adventure']);
  assert.deepEqual(i.steamCategories, ['Single-player']);
  assert.equal(i.metacritic, 91);
  assert.equal(i.website, '', 'URL non-http ditolak');
});

test('game info: data kosong/aneh tidak melempar dan tidak mengarang nilai', () => {
  for (const d of [{}, undefined, { developers: 'x', genres: 5, metacritic: 'abc', release_date: [] }, { metacritic: { score: 250 } }]) {
    const i = parseGameInfo(d);
    assert.equal(i.developer, ''); assert.equal(i.publisher, ''); assert.equal(i.releaseDate, '');
    assert.deepEqual(i.genres, []); assert.equal(i.metacritic, null);
  }
  assert.equal(parseGameInfo({ release_date: { coming_soon: true, date: 'Coming soon' } }).comingSoon, true);
});

test('joinNames: dipotong di batas nama, bukan di tengah nama', () => {
  assert.equal(joinNames(['Aaaa', 'Bbbb', 'Cccc'], 10), 'Aaaa, Bbbb');
  assert.equal(joinNames([], 10), '');
});
