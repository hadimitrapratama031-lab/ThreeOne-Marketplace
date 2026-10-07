import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOldR2Env, createOldSource } from '../scripts/_oldR2.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('readOldR2Env: kosong = mode URL; sebagian = tidak lengkap (menyebut yang kurang); lengkap = mode API', () => {
  assert.deepEqual([readOldR2Env({}).any, readOldR2Env({}).complete], [false, false]);
  const part = readOldR2Env({ OLD_R2_ACCOUNT_ID: ' "abc" ', OLD_R2_BUCKET_NAME: 'bkt' });
  assert.equal(part.any, true); assert.equal(part.complete, false); assert.deepEqual(part.missing, ['OLD_R2_ACCESS_KEY_ID', 'OLD_R2_SECRET_ACCESS_KEY']);
  assert.equal(part.accountId, 'abc'); assert.equal(part.endpoint, 'https://abc.r2.cloudflarestorage.com');
  const full = readOldR2Env({ OLD_R2_ACCOUNT_ID: 'a', OLD_R2_ACCESS_KEY_ID: 'k', OLD_R2_SECRET_ACCESS_KEY: 's', OLD_R2_BUCKET_NAME: 'b', OLD_R2_PUBLIC_URL: 'https://pub.r2.dev/' });
  assert.equal(full.complete, true); assert.equal(full.publicUrl, 'https://pub.r2.dev');
});

test('mode URL: exists/get lewat HTTP; 404 = tidak ada; gagal unduh melempar pesan jelas', async () => {
  const fetchImpl = async (url, opt = {}) => {
    const ok = url.endsWith('/ada.png');
    if (opt.method === 'HEAD') return { ok, status: ok ? 200 : 404 };
    if (opt.headers?.Range) return { ok: false, status: ok ? 206 : 404 };
    if (!ok) return { ok: false, status: 404, headers: new Headers() };
    return { ok: true, status: 200, headers: new Headers({ 'content-length': String(PNG.length) }), arrayBuffer: async () => PNG };
  };
  const src = createOldSource(readOldR2Env({}), { fetchImpl });
  assert.equal(src.mode, 'http');
  assert.equal(await src.exists({ key: '', url: 'https://old.r2.dev/ada.png' }), true);
  assert.equal(await src.exists({ key: '', url: 'https://old.r2.dev/tidak.png' }), false);
  assert.equal(await src.exists({ key: 'products/x.png', url: '' }), false, 'tanpa URL & tanpa API: tidak bisa dicek');
  assert.ok((await src.get({ key: '', url: 'https://old.r2.dev/ada.png' })).equals(PNG));
  await assert.rejects(src.get({ key: '', url: 'https://old.r2.dev/tidak.png' }), /HTTP 404/);
  await assert.rejects(src.get({ key: 'products/x.png', url: '' }), /tidak ada key maupun URL/);
});

test('keyOf: memakai imageKey; bila kosong diturunkan dari URL publik lama', () => {
  const src = createOldSource(readOldR2Env({ OLD_R2_PUBLIC_URL: 'https://pub.r2.dev' }));
  assert.equal(src.keyOf({ key: '/products/a.png', url: '' }), 'products/a.png');
  assert.equal(src.keyOf({ key: '', url: 'https://pub.r2.dev/products/foto%20a.png?x=1' }), 'products/foto a.png');
  assert.equal(src.keyOf({ key: '', url: 'https://lain.com/a.png' }), '');
});
