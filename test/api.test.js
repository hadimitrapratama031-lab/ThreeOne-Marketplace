import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, PNG, ADMIN } from './helpers/boot.js';

let t; let a;
before(async () => { t = await boot(); a = await t.admin(); });
after(async () => { await t.stop(); });

const mkCat = async (name) => (await a.post('/categories', { name })).body.item;
const mkProduct = async (over = {}) => {
  const cat = over.category || (await mkCat('Cat ' + Math.random().toString(36).slice(2, 7))).id;
  const r = await a.post('/products', { name: 'Produk Uji', category: cat, price: 10000, stock: 5, ...over });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.item;
};

test('auth: login salah ditolak, benar mendapat cookie httpOnly', async () => {
  const bad = await t.req('/api/admin/auth/login', { method: 'POST', body: { email: ADMIN.email, password: 'salah-salah-1' } });
  assert.equal(bad.status, 401);
  const ok = await t.req('/api/admin/auth/login', { method: 'POST', body: ADMIN });
  assert.equal(ok.status, 200);
  const cookie = ok.res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.equal(JSON.stringify(ok.body).includes('passwordHash'), false);
});

test('auth: semua endpoint admin menolak permintaan tanpa sesi', async () => {
  for (const p of ['/products', '/categories', '/reviews', '/faq', '/contacts', '/settings', '/media', '/dashboard', '/meta']) {
    assert.equal((await t.req('/api/admin' + p)).status, 401, p);
  }
  assert.equal((await t.req('/api/admin/products', { method: 'POST', body: {}, headers: { cookie: 'mp_admin=bukan.jwt.valid' } })).status, 401);
});

test('auth: Origin lintas situs ditolak untuk mutasi', async () => {
  const r = await t.req('/api/admin/categories', { method: 'POST', body: { name: 'X' }, cookie: a.cookie, headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('auth: ganti password mencabut sesi lain', async () => {
  const other = await t.login();
  const me = await t.req('/api/admin/auth/me', { cookie: other });
  assert.equal(me.status, 200);
  const bad = await a.post('/auth/me/password', { currentPassword: 'salah', newPassword: 'password-baru-123' });
  assert.equal(bad.status, 422);
  const ch = await t.req('/api/admin/auth/me/password', { method: 'POST', cookie: other, body: { currentPassword: ADMIN.password, newPassword: ADMIN.password + '!' } });
  assert.equal(ch.status, 200);
  assert.equal((await t.req('/api/admin/auth/me', { cookie: a.cookie })).status, 401, 'sesi lama harus tidak berlaku');
  // kembalikan password agar tes lain tetap bisa login
  await t.req('/api/admin/auth/me/password', { method: 'POST', cookie: ch.res.headers.get('set-cookie').split(';')[0], body: { currentPassword: ADMIN.password + '!', newPassword: ADMIN.password } });
  a = await t.admin();
});

test('validasi produk: field error jelas dan tidak ada data tersimpan', async () => {
  const cat = await mkCat('Validasi');
  const r = await a.post('/products', { name: '', category: cat.id, price: -5, stock: 1.5 });
  assert.equal(r.status, 422);
  assert.ok(r.body.error.details.fields.name);
  assert.ok(r.body.error.details.fields.price);
  assert.ok(r.body.error.details.fields.stock);
  const r2 = await a.post('/products', { name: 'Diskon salah', category: cat.id, price: 5000, oldPrice: 4000, stock: 1 });
  assert.equal(r2.status, 422);
  assert.ok(r2.body.error.details.fields.oldPrice);
  const r3 = await a.post('/products', { name: 'Kategori hantu', category: '0'.repeat(24), price: 1, stock: 1 });
  assert.equal(r3.status, 422);
  const r4 = await a.post('/products', { name: 'Media palsu', category: cat.id, price: 1, stock: 1, media: [{ key: 'products/2026/01/tidak-ada.png' }] });
  assert.equal(r4.status, 422);
  const list = await a.get('/products?q=Diskon%20salah');
  assert.equal(list.body.total, 0);
});

test('upload: tipe diperiksa dari isi file, ukuran dibatasi, URL publik valid', async () => {
  const fake = await a.upload(Buffer.from('<?php echo 1; ?> bukan gambar sama sekali'), 'products', 'shell.jpg');
  assert.equal(fake.status, 415);
  const svg = await a.upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'products', 'x.svg');
  assert.equal(svg.status, 415, 'SVG ditolak (risiko XSS)');
  const big = await a.upload(Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]));
  assert.equal(big.status, 413);
  const ok = await a.upload();
  assert.equal(ok.status, 201);
  const { key, url } = ok.body.asset;
  assert.match(key, /^products\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
  assert.ok(url.startsWith(process.env.R2_PUBLIC_URL + '/'), 'URL memakai R2_PUBLIC_URL');
  assert.equal(url.includes('localhost'), false);
  const fetched = await fetch(url);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers.get('content-type'), 'image/png');
  const video = await a.upload(Buffer.from('000000186674797069736f6d0000000069736f6d', 'hex').length ? Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(20)]) : PNG, 'hero', 'v.mp4');
  assert.equal(video.status, 422, 'video hanya untuk produk');
});

test('upload video: brand MP4 umum diterima & tersimpan sebagai video/mp4; QuickTime ditolak 415 (bukan 500)', async () => {
  for (const brand of ['isom', 'mp42', 'iso5', 'mp71']) {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp' + brand), Buffer.alloc(30)]);
    const v = await a.upload(mp4, 'products', 'v.mp4');
    assert.equal(v.status, 201, brand);
    assert.equal(v.body.asset.kind, 'video');
    assert.equal(v.body.asset.mime, 'video/mp4');
    assert.equal(t.s3.store.get('bkt/' + v.body.asset.key).type, 'video/mp4', 'Content-Type objek di R2');
    assert.match(v.body.asset.key, /\.mp4$/);
  }
  const mov = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypqt  '), Buffer.alloc(30)]);
  assert.equal((await a.upload(mov, 'products', 'v.mov')).status, 415);
});

test('upload: R2 menolak tulis (403 AccessDenied) -> 503 berpesan jelas, bukan 500; rahasia tidak bocor; tak ada aset yatim', async () => {
  const totalBefore = (await a.get('/media')).body.total;
  const logs = [];
  const origError = console.error;
  console.error = (...x) => logs.push(x.join(' '));
  t.s3.fail.put = true;
  let r;
  try { r = await a.upload(); } finally { t.s3.fail.put = false; console.error = origError; }
  assert.equal(r.status, 503);
  assert.match(r.body.error.message, /AccessDenied/);
  assert.match(r.body.error.message, /Object Read & Write/);
  const wire = JSON.stringify(r.body);
  const logged = logs.join('\n');
  assert.match(logged, /\[r2\] PutObject GAGAL status=403 code=AccessDenied jenis=permission bucket=bkt/);
  for (const secret of ['TOP-SECRET-R2-VALUE', 'AKIATESTKEY']) {
    assert.equal(wire.includes(secret), false, 'respons API tidak memuat rahasia R2');
    assert.equal(logged.includes(secret), false, 'log server tidak memuat rahasia R2');
  }
  assert.equal((await a.get('/media')).body.total, totalBefore, 'tidak ada catatan aset untuk upload yang gagal');
  assert.equal((await a.upload()).status, 201, 'upload kembali normal setelah R2 pulih');
});

test('upload: field salah / multipart rusak -> 400 jelas (bukan 500)', async () => {
  const wrong = new FormData();
  wrong.append('folder', 'products');
  wrong.append('image', new Blob([PNG]), 'a.png');
  const r1 = await t.req('/api/admin/media', { method: 'POST', cookie: a.cookie, form: wrong });
  assert.equal(r1.status, 400);
  assert.match(r1.body.error.message, /"file"/);
  const r2 = await t.req('/api/admin/media', { method: 'POST', cookie: a.cookie, headers: { 'content-type': 'multipart/form-data' }, form: 'bukan multipart' });
  assert.equal(r2.status, 400);
  const r3 = await t.req('/api/admin/media', { method: 'POST', cookie: a.cookie, form: new FormData() });
  assert.equal(r3.status, 400, 'tanpa file');
});

test('gambar produk: upload -> simpan -> ganti -> hapus mengikuti urutan aman', async () => {
  const u1 = (await a.upload()).body.asset;
  const u2 = (await a.upload()).body.asset;
  const p = await mkProduct({ name: 'Gambar', media: [{ key: u1.key }, { key: u2.key }] });
  assert.deepEqual(p.media.map((m) => m.key), [u1.key, u2.key]);
  assert.ok(t.inBucket(u1.key) && t.inBucket(u2.key));

  // Simpan gagal validasi -> gambar lama TIDAK boleh terhapus
  const u3 = (await a.upload()).body.asset;
  const fail = await a.put(`/products/${p.id}`, { name: 'Gambar', category: p.category.id, price: -1, stock: 1, media: [{ key: u3.key }] });
  assert.equal(fail.status, 422);
  assert.ok(t.inBucket(u1.key) && t.inBucket(u2.key), 'gambar lama masih ada setelah simpan gagal');

  // Ganti gambar: baru dipakai, yang tidak dipakai lagi terhapus dari R2
  const ok = await a.put(`/products/${p.id}`, { name: 'Gambar', category: p.category.id, price: 20000, stock: 1, media: [{ key: u3.key }, { key: u2.key }] });
  assert.equal(ok.status, 200);
  assert.equal(t.inBucket(u1.key), false, 'u1 dihapus karena sudah tidak dipakai');
  assert.ok(t.inBucket(u2.key) && t.inBucket(u3.key));

  // File milik produk lain tidak boleh diklaim
  const other = await mkProduct({ name: 'Lain' });
  const steal = await a.put(`/products/${other.id}`, { name: 'Lain', category: other.category.id, price: 1, stock: 1, media: [{ key: u2.key }] });
  assert.equal(steal.status, 409);

  // Hapus produk -> semua file R2 miliknya ikut terhapus
  const del = await a.del(`/products/${p.id}`);
  assert.equal(del.status, 200);
  assert.equal(t.inBucket(u2.key) || t.inBucket(u3.key), false);
  assert.equal((await a.get(`/products/${p.id}`)).status, 404);
});

test('galeri produk: jumlah gambar & video tidak dibatasi; duplikat dan key tak dikenal tetap ditolak', async () => {
  const ups = [];
  for (let i = 0; i < 12; i++) ups.push((await a.upload()).body.asset.key);
  const cat = await mkCat('Batas');
  const r = await a.post('/products', { name: 'Banyak gambar', category: cat.id, price: 1, stock: 1, media: ups.map((key) => ({ key })) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.item.media.length, 12);
  const vids = [];
  for (let i = 0; i < 3; i++) {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(30)]);
    const v = await a.upload(mp4, 'products', 'v.mp4');
    assert.equal(v.status, 201);
    vids.push(v.body.asset.key);
  }
  const r2 = await a.post('/products', { name: 'Tiga video', category: cat.id, price: 1, stock: 1, media: vids.map((key) => ({ key })) });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.deepEqual(r2.body.item.media.map((m) => m.type), ['video', 'video', 'video']);
  const dup = await a.post('/products', { name: 'Duplikat', category: cat.id, price: 1, stock: 1, media: [{ key: ups[0] }, { key: ups[0] }] });
  assert.equal(dup.status, 422);
});

test('paginasi, pencarian, filter, dan urutan dilakukan di server', async () => {
  const cat = await mkCat('Massal');
  for (let i = 1; i <= 30; i++) await a.post('/products', { name: `Massal ${String(i).padStart(2, '0')}`, category: cat.id, price: i * 1000, stock: i % 4 === 0 ? 0 : i, active: i % 5 !== 0 });
  const p1 = await a.get(`/products?category=${cat.id}`);
  assert.equal(p1.body.limit, 25);
  assert.equal(p1.body.items.length, 25);
  assert.equal(p1.body.total, 30);
  assert.equal(p1.body.totalPages, 2);
  const p2 = await a.get(`/products?category=${cat.id}&page=2`);
  assert.equal(p2.body.items.length, 5);
  const ids = new Set([...p1.body.items, ...p2.body.items].map((x) => x.id));
  assert.equal(ids.size, 30, 'tidak ada duplikat antar halaman');
  assert.equal((await a.get(`/products?category=${cat.id}&q=massal%2007`)).body.total, 1);
  assert.equal((await a.get(`/products?category=${cat.id}&stock=out`)).body.total, 7);
  assert.equal((await a.get(`/products?category=${cat.id}&status=inactive`)).body.total, 6);
  const asc = (await a.get(`/products?category=${cat.id}&sort=price_asc&limit=3`)).body.items.map((x) => x.price);
  assert.deepEqual(asc, [1000, 2000, 3000]);
  assert.equal((await a.get('/products?limit=500')).status, 422);
  assert.equal((await a.get('/products?q=' + encodeURIComponent('.*(['))).status, 200, 'karakter regex tidak merusak pencarian');
});

test('kategori: nama unik, hapus butuh pemindahan produk, reorder tersimpan', async () => {
  const c1 = await mkCat('Alfa');
  assert.equal((await a.post('/categories', { name: 'alfa' })).status, 409, 'unik tanpa peduli huruf besar');
  const c2 = await mkCat('Beta');
  const p = await mkProduct({ category: c1.id, name: 'Di Alfa' });
  const blocked = await a.del(`/categories/${c1.id}`);
  assert.equal(blocked.status, 409);
  const moved = await a.del(`/categories/${c1.id}?moveTo=${c2.id}`);
  assert.equal(moved.status, 200);
  assert.equal((await a.get(`/products/${p.id}`)).body.item.category.id, c2.id);

  const all = (await a.get('/categories')).body.items;
  const reversed = [...all].reverse().map((c) => c.id);
  const re = await a.put('/categories/reorder', { ids: reversed });
  assert.deepEqual(re.body.items.map((c) => c.id), reversed);
});

test('publik: hanya data aktif tampil; produk/kategori nonaktif hilang; ulasan tersembunyi tidak dihitung', async () => {
  const cat = await mkCat('Publik');
  const p = await mkProduct({ name: 'Terlihat', category: cat.id });
  const pid = p.productId;
  const boot1 = (await t.req('/api/public/bootstrap')).body;
  assert.ok(boot1.products.some((x) => x.id === pid));

  await a.patch(`/products/${p.id}/status`, { active: false });
  assert.equal((await t.req(`/api/public/products/${pid}`)).status, 404);
  assert.equal((await t.req('/api/public/bootstrap')).body.products.some((x) => x.id === pid), false);
  await a.patch(`/products/${p.id}/status`, { active: true });
  assert.equal((await t.req(`/api/public/products/${pid}`)).status, 200);

  await a.put(`/categories/${cat.id}`, { name: 'Publik', active: false });
  assert.equal((await t.req(`/api/public/products/${pid}`)).status, 404, 'kategori nonaktif menyembunyikan produk');
  await a.put(`/categories/${cat.id}`, { name: 'Publik', active: true });

  const r1 = (await a.post('/reviews', { productId: pid, name: 'A', stars: 5, text: 'bagus' })).body.item;
  await a.post('/reviews', { productId: pid, name: 'B', stars: 1, text: 'jelek' });
  assert.equal((await t.req(`/api/public/products/${pid}`)).body.reviews.total, 2);
  await a.patch(`/reviews/${r1.id}/status`, { active: false });
  const after = (await t.req(`/api/public/products/${pid}`)).body.reviews;
  assert.equal(after.total, 1);
  assert.equal(after.avg, 1);
  const list = (await t.req(`/api/public/products/${pid}/reviews`)).body;
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].name, 'B');
});

test('konten: hero, FAQ, kontak, pengaturan tersimpan dan tervalidasi', async () => {
  const hero = (await a.get('/settings')).body.settings.hero;
  const bad = await a.put('/settings/hero', { ...hero, primaryCta: { label: 'Klik', href: 'javascript:alert(1)' }, covers: [null, null, null] });
  assert.equal(bad.status, 422, 'javascript: ditolak');
  const c1 = (await a.upload(PNG, 'hero')).body.asset;
  const c2 = (await a.upload(PNG, 'hero')).body.asset;
  const set = (covers) => a.put('/settings/hero', { ...hero, eyebrow: '', title: 'Judul Baru', covers });
  assert.equal((await set([{ key: c1.key }, null, null])).status, 200);
  assert.equal((await set([{ key: c2.key }, null, null])).status, 200);
  assert.equal(t.inBucket(c1.key), false, 'cover lama dihapus setelah diganti');
  assert.ok(t.inBucket(c2.key));
  const pub = (await t.req('/api/public/bootstrap')).body.settings.hero;
  assert.equal(pub.title, 'Judul Baru');
  assert.equal(pub.covers[0], `${process.env.R2_PUBLIC_URL}/${c2.key}`);
  assert.equal((await a.put('/settings/hero', { ...hero, covers: [{ key: (await a.upload()).body.asset.key }, null, null] })).status, 422, 'folder produk tidak boleh dipakai hero');

  const f = (await a.post('/faq', { question: 'Apakah aman?', answer: 'Ya.' })).body.item;
  const f2 = (await a.post('/faq', { question: 'Kedua?', answer: 'Ya juga.' })).body.item;
  await a.put('/faq/reorder', { ids: [f2.id, f.id] });
  const order = (await t.req('/api/public/bootstrap')).body.faq.map((x) => x.q);
  assert.deepEqual(order.slice(0, 2), ['Kedua?', 'Apakah aman?']);
  await a.patch(`/faq/${f.id}/status`, { active: false });
  assert.equal((await t.req('/api/public/bootstrap')).body.faq.some((x) => x.id === f.id), false);

  const badContact = await a.post('/contacts', { label: 'X', value: 'y', href: 'javascript:alert(1)' });
  assert.equal(badContact.status, 422);
  assert.equal((await a.post('/contacts', { label: 'WA', value: '+62', href: 'https://wa.me/62', icon: 'whatsapp' })).status, 201);

  const stats = await a.put('/settings/stats', { customers: -1, orders: 5, support: '24/7' });
  assert.equal(stats.status, 422);
});

test('keamanan: tidak ada rahasia di respons publik/admin, image-error hanya untuk URL R2', async () => {
  const dump = JSON.stringify([(await t.req('/api/public/bootstrap')).body, (await a.get('/meta')).body, (await a.get('/settings')).body, (await a.get('/dashboard')).body]);
  for (const secret of ['TOP-SECRET-R2-VALUE', 'AKIATESTKEY', 'passwordHash', process.env.APP_SECRET, process.env.MONGODB_URI]) {
    assert.equal(dump.includes(secret), false, `bocor: ${secret}`);
  }
  const pub = (await t.req('/api/public/bootstrap')).body;
  for (const p of pub.products) assert.equal('active' in p || 'media' in p, false, 'kartu publik tidak membawa field admin');
  assert.equal((await t.req('/api/public/image-error', { method: 'POST', body: { url: 'https://evil.example/x.png', page: '/' } })).status, 204);
  assert.equal((await a.get('/media/errors')).body.items.length, 0, 'URL di luar R2 diabaikan');
  const url = `${process.env.R2_PUBLIC_URL}/products/2026/01/hilang.png`;
  await t.req('/api/public/image-error', { method: 'POST', body: { url, page: '/' } });
  assert.equal((await a.get('/media/errors')).body.items[0].url, url);
  const h = (await t.req('/')).res.headers;
  assert.match(h.get('content-security-policy') || '', /default-src 'self'/);
  assert.equal(h.get('x-powered-by'), null);
});

test('dashboard: metrik berasal dari database', async () => {
  const d = (await a.get('/dashboard')).body;
  const total = (await a.get('/products?limit=1')).body.total;
  assert.equal(d.products.total, total);
  assert.equal(d.products.active + d.products.inactive, total);
  assert.equal(d.products.out, (await a.get('/products?stock=out&limit=1')).body.total);
  assert.equal(typeof d.online, 'number');
});
