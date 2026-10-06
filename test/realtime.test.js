import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { boot, until } from './helpers/boot.js';

let t; let a;
const sockets = [];
before(async () => { t = await boot(); a = await t.admin(); });
after(async () => { sockets.forEach((s) => s.close()); await t.stop(); });

/** Klien Socket.IO yang mencatat semua event */
function client(ns = '/', opts = {}) {
  const s = io(t.base + ns, { transports: ['websocket'], reconnectionDelay: 50, reconnectionDelayMax: 100, ...opts });
  const events = [];
  s.onAny((name, payload) => events.push({ name, payload }));
  sockets.push(s);
  const api = {
    s, events,
    ready: new Promise((resolve, reject) => { s.once('connect', resolve); s.once('connect_error', reject); }),
    count: (name) => events.filter((e) => e.name === name).length,
    wait: (name, pred = () => true, timeout = 3000) => until(() => events.find((e) => e.name === name && pred(e.payload)), { timeout }),
    clear: () => { events.length = 0; },
  };
  return api;
}

const PUBLIC_PRODUCT_KEYS = ['category', 'categoryId', 'createdAt', 'description', 'id', 'imageUrl', 'name', 'price', 'stock', 'updatedAt'];

test('Admin -> Marketplace: produk create/update/hide/show/delete sampai ke klien publik', async () => {
  const pub = client(); await pub.ready;
  const cat = (await a.post('/categories', { name: 'Realtime' })).body.item;
  await pub.wait('category:create');

  const img = (await a.upload()).body.asset;
  const p = (await a.post('/products', { name: 'RT Produk', category: cat.id, price: 11000, stock: 4, media: [{ key: img.key }] })).body.item;
  const created = (await pub.wait('product:create', (x) => x.id === p.productId)).payload;
  assert.deepEqual(Object.keys(created).sort(), PUBLIC_PRODUCT_KEYS, 'payload publik hanya berisi field publik');
  assert.equal(created.imageUrl, `${process.env.R2_PUBLIC_URL}/${img.key}`);

  pub.clear();
  await a.put(`/products/${p.id}`, { name: 'RT Produk v2', category: cat.id, price: 12500, stock: 4, media: [{ key: img.key }] });
  const upd = (await pub.wait('product:update')).payload;
  assert.equal(upd.name, 'RT Produk v2');
  assert.equal(upd.price, 12500);

  pub.clear();
  await a.patch(`/products/${p.id}/status`, { active: false });
  assert.equal((await pub.wait('product:delete')).payload.id, p.productId, 'nonaktif = hilang di Marketplace');
  pub.clear();
  await a.patch(`/products/${p.id}/status`, { active: true });
  await pub.wait('product:create');

  pub.clear();
  await a.del(`/products/${p.id}`);
  assert.equal((await pub.wait('product:delete')).payload.id, p.productId);
  assert.equal(pub.count('product:delete'), 1, 'tepat satu event');
});

test('Admin -> Marketplace: kategori, hero, FAQ, kontak, pengaturan, ulasan', async () => {
  const pub = client(); await pub.ready;
  const cat = (await a.post('/categories', { name: 'Kat RT' })).body.item;
  pub.clear();
  await a.put(`/categories/${cat.id}`, { name: 'Kat RT 2', active: true });
  assert.equal((await pub.wait('category:update')).payload.name, 'Kat RT 2');

  const hero = (await a.get('/settings')).body.settings.hero;
  await a.put('/settings/hero', { ...hero, title: 'Judul RT', covers: [null, null, null] });
  assert.equal((await pub.wait('hero:update')).payload.title, 'Judul RT');

  await a.put('/settings/stats', { support: '09-17' });
  assert.equal((await pub.wait('settings:update', (x) => x.key === 'stats')).payload.value.support, '09-17');

  const f = (await a.post('/faq', { question: 'Tanya RT?', answer: 'Jawab' })).body.item;
  await pub.wait('faq:create', (x) => x.q === 'Tanya RT?');
  await a.put(`/faq/${f.id}`, { question: 'Tanya RT 2?', answer: 'Jawab', active: true });
  await pub.wait('faq:update', (x) => x.q === 'Tanya RT 2?');
  await a.patch(`/faq/${f.id}/status`, { active: false });
  await pub.wait('faq:delete', (x) => x.id === f.id);

  const c = (await a.post('/contacts', { label: 'Mail', value: 'a@b.id', href: 'mailto:a@b.id', icon: 'email' })).body.item;
  await pub.wait('contact:create');
  await a.put(`/contacts/${c.id}`, { label: 'Mail', value: 'baru@b.id', href: 'mailto:baru@b.id', icon: 'email' });
  assert.equal((await pub.wait('contact:update')).payload.value, 'baru@b.id');

  const prod = (await a.post('/products', { name: 'Untuk ulasan', category: cat.id, price: 1000, stock: 1 })).body.item;
  const r = (await a.post('/reviews', { productId: prod.productId, name: 'Budi', stars: 5, text: 'mantap' })).body.item;
  await pub.wait('review:create', (x) => x.productId === prod.productId);
  await a.patch(`/reviews/${r.id}/status`, { active: false });
  await pub.wait('review:delete', (x) => x.id === r.id);
});

test('namespace /admin: wajib login; event admin membawa data lengkap', async () => {
  const anon = client('/admin');
  await assert.rejects(anon.ready, /unauthorized/);

  const adm = client('/admin', { extraHeaders: { cookie: a.cookie } }); await adm.ready;
  const cat = (await a.post('/categories', { name: 'Adm RT' })).body.item;
  await adm.wait('category:create');
  const p = (await a.post('/products', { name: 'Adm Produk', category: cat.id, price: 1, stock: 1 })).body.item;
  const ev = (await adm.wait('product:create')).payload;
  assert.equal(ev.id, p.id);
  assert.ok('media' in ev && 'active' in ev, 'admin menerima field lengkap');
  await a.patch(`/products/${p.id}/status`, { active: false });
  await adm.wait('product:update', (x) => x.active === false);
});

test('Marketplace -> Admin: jumlah pengunjung online dikirim realtime', async () => {
  // mulai dari kondisi bersih: tutup semua klien dari tes sebelumnya
  sockets.splice(0).forEach((s) => s.close());
  const adm = client('/admin', { extraHeaders: { cookie: a.cookie } }); await adm.ready;
  const latest = () => adm.events.filter((e) => e.name === 'presence:update').at(-1)?.payload.online;
  await until(() => latest() === 0, { timeout: 4000 });

  const v1 = client(); await v1.ready;
  const v2 = client(); await v2.ready;
  await until(() => latest() === 2, { timeout: 4000 });
  v1.s.close();
  await until(() => latest() === 1, { timeout: 4000 });
  v2.s.close();
  await until(() => latest() === 0, { timeout: 4000 });
});

test('reconnect: satu listener, tidak ada event ganda, data tersinkron lewat API', async () => {
  const pub = client(); await pub.ready;
  let seen = 0;
  pub.s.on('faq:create', () => { seen++; });          // didaftarkan sekali, seperti live.js
  for (let i = 0; i < 3; i++) {
    const back = new Promise((r) => pub.s.once('connect', r));
    pub.s.io.engine.close();                            // putus paksa
    await back;
  }
  assert.equal(pub.s.listeners('faq:create').length, 1, 'listener tidak bertambah setelah reconnect');
  seen = 0; pub.clear();
  await a.post('/faq', { question: 'Setelah reconnect?', answer: 'Ya' });
  await pub.wait('faq:create');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(seen, 1);
  assert.equal(pub.count('faq:create'), 1);

  // Perubahan saat klien offline tidak hilang: dikejar lewat API setelah tersambung lagi
  pub.s.disconnect();
  await a.post('/faq', { question: 'Saat offline?', answer: 'Ya' });
  const resync = (await t.req('/api/public/bootstrap')).body.faq.map((x) => x.q);
  assert.ok(resync.includes('Saat offline?'));
});
