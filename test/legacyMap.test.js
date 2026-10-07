import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, makeBlurb, legacyImageRefs, legacyNewKey, legacyMarker, isLegacyKey, dbTarget, mapOrderStatus } from '../scripts/legacyMap.js';

test('cleanText: baris baru dipertahankan, spasi dirapikan, dipotong di batas', () => {
  assert.equal(cleanText('  Baris  satu \r\n\r\n\r\n\r\nBaris\tdua  ', 4000), 'Baris satu\n\nBaris dua');
  assert.equal(cleanText('abcdef', 3), 'abc');
  assert.equal(cleanText(null, 10), '');
});

test('makeBlurb: shortDescription dipakai apa adanya; kosong → awal deskripsi dipotong di kata; tidak mengarang', () => {
  assert.equal(makeBlurb('Ringkas', 'Panjang sekali'), 'Ringkas');
  assert.equal(makeBlurb('', 'Pendek saja'), 'Pendek saja');
  assert.equal(makeBlurb('', ''), '');
  const long = `${'kata '.repeat(100)}akhir`;
  const b = makeBlurb('', long, 50);
  assert.ok(b.length <= 50 && b.endsWith('…') && !b.includes('akhir'));
  assert.equal(makeBlurb('x'.repeat(400), '', 300).length, 300);
});

test('legacyImageRefs: utama dulu, lalu tambahan; tanpa duplikat & tanpa entri kosong', () => {
  const refs = legacyImageRefs({
    imageKey: 'products/a.png', image: 'https://pub.r2.dev/products/a.png',
    additionalImages: [{ key: 'products/b.png', url: 'u-b' }, { key: 'products/a.png', url: 'dup' }, { key: '', url: '' }, { key: '', url: 'https://x/c.jpg' }],
  });
  assert.deepEqual(refs, [{ key: 'products/a.png', url: 'https://pub.r2.dev/products/a.png' }, { key: 'products/b.png', url: 'u-b' }, { key: '', url: 'https://x/c.jpg' }]);
  assert.deepEqual(legacyImageRefs({}), []);
  assert.deepEqual(legacyImageRefs({ additionalImages: 'rusak' }), []);
});

test('legacyNewKey: deterministik per produk+gambar, aman sebagai key R2; marker memuat key lama', () => {
  const k1 = legacyNewKey('abc123', { key: 'products/1712-uuid-1.PNG', url: '' }, 'png');
  assert.equal(k1, 'products/legacy/abc123/1712-uuid-1.png');
  assert.equal(legacyNewKey('abc123', { key: 'products/1712-uuid-1.PNG', url: '' }, 'png'), k1);
  assert.notEqual(legacyNewKey('other', { key: 'products/1712-uuid-1.PNG', url: '' }, 'png'), k1);
  assert.match(legacyNewKey('o', { key: '', url: 'https://x.dev/p/foto bagus (1).jpg?x=1' }, 'jpg'), /^products\/legacy\/o\/foto-bagus-1\.jpg$/);
  assert.match(legacyNewKey('o', { key: '', url: 'https://x.dev/' }, 'jpg'), /^products\/legacy\/o\/[0-9a-f]{16}\.jpg$/);
  assert.ok(isLegacyKey(k1) && !isLegacyKey('products/2026/10/x.png'));
  assert.equal(legacyMarker({ key: 'products/a.png', url: 'u' }), 'legacy:products/a.png');
  assert.ok(legacyMarker({ key: '', url: `https://x/${'a'.repeat(300)}` }).length <= 200);
});

test('dbTarget: host + nama database tanpa kredensial; tahan URI multi-host', () => {
  assert.equal(dbTarget('mongodb+srv://u:p@Cluster0.abc.mongodb.net/?appName=x', 'test'), 'cluster0.abc.mongodb.net/test');
  assert.equal(dbTarget('mongodb://a:1,b:2/db?replicaSet=r', 'DB'), 'a:1,b:2/db');
  assert.equal(dbTarget('mongodb+srv://x:y@h/a', 'test'), dbTarget('mongodb+srv://other:pw@H/b', 'TEST'));
  assert.notEqual(dbTarget('mongodb+srv://x@h/a', 'old'), dbTarget('mongodb+srv://x@h/a', 'new'));
});

test('mapOrderStatus: COMPLETED/PAID/SUCCESS atau paidAt = SUCCESS; sisanya bukan SUCCESS', () => {
  assert.equal(mapOrderStatus({ status: 'COMPLETED' }), 'SUCCESS');
  assert.equal(mapOrderStatus({ status: 'PAID' }), 'SUCCESS');
  assert.equal(mapOrderStatus({ status: 'PENDING', paymentStatus: 'SUCCESS' }), 'SUCCESS');
  assert.equal(mapOrderStatus({ status: 'EXPIRED' }, { paidAt: new Date() }), 'SUCCESS');
  assert.equal(mapOrderStatus({ status: 'PENDING' }), 'EXPIRED');
  assert.equal(mapOrderStatus({ status: 'CANCELLED' }), 'FAILED');
});
