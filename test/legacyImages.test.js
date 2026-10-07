import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateProductImages } from '../scripts/_legacyImages.js';
import { sniff } from '../server/lib/sniff.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);

/** Dependensi tiruan: "R2 lama" (Map key→Buffer), "R2 baru" (Map), dan koleksi Asset (Map key→dokumen). */
function world(oldFiles) {
  const oldR2 = new Map(Object.entries(oldFiles)); const newR2 = new Map(); const assets = new Map(); const calls = { put: 0, get: 0 };
  const deps = {
    source: {
      exists: async (ref) => oldR2.has(ref.key),
      get: async (ref) => { calls.get += 1; if (!oldR2.has(ref.key)) throw new Error('tidak ada di bucket lama'); return oldR2.get(ref.key); },
    },
    sniff,
    putObject: async ({ key, body }) => { calls.put += 1; newR2.set(key, body); },
    headObject: async (key) => (newR2.has(key) ? { exists: true, size: newR2.get(key).length } : { exists: false }),
    publicUrl: (key) => `https://cdn.baru/${key}`,
    findAsset: async (marker, ownerId) => [...assets.values()].find((a) => a.originalName === marker && String(a.ownerId) === String(ownerId)) || null,
    saveAsset: async (a) => { assets.set(a.key, a); },
  };
  return { oldR2, newR2, assets, calls, deps };
}
const refs = (...keys) => keys.map((key) => ({ key, url: `https://old.r2.dev/${key}` }));

test('apply: gambar utama + tambahan disalin berurutan ke key baru dan didaftarkan sebagai aset produk', async () => {
  const w = world({ 'products/a.png': PNG, 'products/b.jpg': JPG });
  const r = await migrateProductImages({ refs: refs('products/a.png', 'products/b.jpg'), ownerId: 'P1', apply: true }, w.deps);
  assert.equal(r.copied, 2); assert.equal(r.reused, 0); assert.equal(r.failed.length, 0);
  assert.deepEqual(r.items.map((i) => i.key), ['products/legacy/P1/a.png', 'products/legacy/P1/b.jpg']);
  assert.equal(r.items[0].url, 'https://cdn.baru/products/legacy/P1/a.png');
  assert.ok(w.newR2.get('products/legacy/P1/a.png').equals(PNG), 'isi file identik');
  const a = w.assets.get('products/legacy/P1/b.jpg');
  assert.equal(a.mime, 'image/jpeg'); assert.equal(a.folder, 'products'); assert.equal(a.kind, 'image'); assert.equal(a.originalName, 'legacy:products/b.jpg');
});

test('jalan ulang tidak menggandakan: aset dipakai ulang, tidak ada upload kedua', async () => {
  const w = world({ 'products/a.png': PNG });
  await migrateProductImages({ refs: refs('products/a.png'), ownerId: 'P1', apply: true }, w.deps);
  const r = await migrateProductImages({ refs: refs('products/a.png'), ownerId: 'P1', apply: true }, w.deps);
  assert.equal(r.reused, 1); assert.equal(r.copied, 0); assert.equal(w.calls.put, 1); assert.equal(w.calls.get, 1); assert.equal(w.newR2.size, 1);
});

test('objek di R2 baru hilang tapi aset tercatat: diunggah ulang ke key yang sama', async () => {
  const w = world({ 'products/a.png': PNG });
  await migrateProductImages({ refs: refs('products/a.png'), ownerId: 'P1', apply: true }, w.deps);
  w.newR2.clear();
  const r = await migrateProductImages({ refs: refs('products/a.png'), ownerId: 'P1', apply: true }, w.deps);
  assert.equal(r.copied, 1); assert.deepEqual(r.items.map((i) => i.key), ['products/legacy/P1/a.png']); assert.equal(w.assets.size, 1);
});

test('produk berbeda dengan gambar lama yang sama tidak bentrok (key memuat id produk)', async () => {
  const w = world({ 'products/a.png': PNG });
  const r1 = await migrateProductImages({ refs: refs('products/a.png'), ownerId: 'P1', apply: true }, w.deps);
  const r2 = await migrateProductImages({ refs: refs('products/a.png'), ownerId: 'P2', apply: true }, w.deps);
  assert.notEqual(r1.items[0].key, r2.items[0].key); assert.equal(w.newR2.size, 2);
});

test('gambar hilang / bukan gambar dicatat sebagai gagal, gambar lain tetap lanjut', async () => {
  const w = world({ 'products/a.png': PNG, 'products/doc.png': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') });
  const r = await migrateProductImages({ refs: refs('products/hilang.png', 'products/doc.png', 'products/a.png'), ownerId: 'P1', apply: true }, w.deps);
  assert.equal(r.copied, 1); assert.equal(r.items.length, 1); assert.equal(r.failed.length, 2);
  assert.match(r.failed[0].reason, /tidak ada di bucket lama/); assert.match(r.failed[1].reason, /format file tidak didukung/);
});

test('verifikasi setelah upload gagal → dicatat gagal, aset TIDAK didaftarkan', async () => {
  const w = world({ 'products/a.png': PNG });
  w.deps.headObject = async () => ({ exists: true, size: 1 });
  const r = await migrateProductImages({ refs: refs('products/a.png'), ownerId: 'P1', apply: true }, w.deps);
  assert.equal(r.items.length, 0); assert.match(r.failed[0].reason, /verifikasi/); assert.equal(w.assets.size, 0);
});

test('dry-run: hanya memeriksa keberadaan gambar lama, tidak menulis apa pun', async () => {
  const w = world({ 'products/a.png': PNG });
  const r = await migrateProductImages({ refs: refs('products/a.png', 'products/hilang.png'), ownerId: undefined, apply: false }, w.deps);
  assert.equal(r.found, 1); assert.equal(r.failed.length, 1); assert.equal(r.items.length, 0);
  assert.equal(w.calls.put, 0); assert.equal(w.calls.get, 0); assert.equal(w.assets.size, 0);
});
