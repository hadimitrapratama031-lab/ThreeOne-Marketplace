import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { boot, until } from './helpers/boot.js';
import { startKlikqrisMock } from './helpers/klikqrisMock.js';

let t; let a; let mock; let product; const sockets = [];
const BUYER = { name: 'Budi Santoso', email: 'Budi@Example.com', whatsapp: '0812 3456 7890' };

before(async () => {
  mock = await startKlikqrisMock();
  process.env.KLIKQRIS_BASE_URL = mock.url;
  t = await boot();
  a = await t.admin();
  const cat = (await a.post('/categories', { name: 'Game' })).body.item;
  product = (await a.post('/products', { name: 'Game Pembayaran', category: cat.id, price: 50000, stock: 3 })).body.item;
});
after(async () => { sockets.forEach((s) => s.close()); await t.stop(); await mock.close(); });

const settings = (over = {}) => ({ mode: 'sandbox', sandbox: { merchantId: 'MRC-SB', apiKey: 'KEY-SB' }, production: {}, waAdmin: '0811 2222 3333', ...over });
const checkout = (over = {}) => t.req('/api/orders', { method: 'POST', body: { productId: product.productId, ...BUYER, ...over } });
const stockNow = async () => (await a.get(`/products/${product.id}`)).body.item.stock;
const read = (o) => t.req(`/api/orders/${o.orderNo}`, { headers: { 'x-order-token': o.token } });

function client(orderNo, token) {
  const s = io(t.base, { transports: ['websocket'] });
  const events = [];
  s.on('order:update', (o) => events.push(o));
  sockets.push(s);
  const ack = new Promise((resolve) => s.once('connect', () => s.emit('order:join', { orderNo, token }, resolve)));
  return { s, events, ack };
}

test('checkout ditolak selama KlikQRIS belum diatur; API Key tidak pernah kembali ke browser', async () => {
  assert.equal((await checkout()).status, 503);
  const put = await a.put('/payment-settings', settings());
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(JSON.stringify(put.body).includes('KEY-SB'), false);
  assert.equal(JSON.stringify((await a.get('/payment-settings')).body).includes('KEY-SB'), false);
  assert.equal((await t.req('/api/public/bootstrap')).body.settings.payment, undefined);
  assert.equal((await t.req('/api/admin/payment-settings')).status, 401);
  assert.equal((await a.put('/payment-settings', settings({ mode: 'production' }))).status, 422, 'mode aktif wajib lengkap');
});

test('checkout: order unik, total_amount dari KlikQRIS, kedaluwarsa 10 menit dari jam server, refresh tidak mereset', async () => {
  const bad = await checkout({ email: 'bukan-email', whatsapp: 'abc' });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.error.details.fields.email && bad.body.error.details.fields.whatsapp);

  const r = await checkout({ clientKey: 'abcdefgh12345678' });
  assert.equal(r.status, 201);
  const again = await checkout({ clientKey: 'abcdefgh12345678' });
  assert.equal(again.body.orderNo, r.body.orderNo, 'klik ganda = order yang sama');
  assert.match(r.body.orderNo, /^MP-\d{6}-[A-Z0-9]{6}$/);

  const o1 = (await read(r.body)).body.order;
  assert.equal(o1.status, 'PENDING');
  assert.equal(o1.amount, 50000);
  assert.equal(o1.totalAmount, 50016, 'nominal final = total_amount KlikQRIS');
  assert.equal(o1.uniqueAmount, 16);
  assert.match(o1.qrisUrl, /^https:\/\/klikqris\.com\/storage\/qris_api\//);
  assert.equal(o1.customer.whatsapp, '6281234567890');
  assert.equal(o1.customer.email, 'budi@example.com');
  assert.equal(o1.waAdmin, '6281122223333');
  const span = Date.parse(o1.expiresAt) - Date.parse(o1.createdAt);
  assert.ok(span > 599_000 && span < 602_000, `masa berlaku ~10 menit (${span} ms)`);
  assert.equal(JSON.stringify(o1).includes('signature'), false);

  await new Promise((r2) => setTimeout(r2, 300));
  assert.equal((await read(r.body)).body.order.expiresAt, o1.expiresAt, 'expiresAt tetap setelah dibaca ulang');

  assert.equal((await t.req(`/api/orders/${r.body.orderNo}`, { headers: { 'x-order-token': 'salah' } })).status, 404);
  assert.equal((await t.req(`/api/orders/${r.body.orderNo}`)).status, 404);
});

test('webhook: signature salah ditolak; PAID sukses SEKALI (idempoten); realtime tepat satu event; stok turun sekali', async () => {
  const o = (await checkout()).body;
  const stock0 = await stockNow();
  const c = client(o.orderNo, o.token);
  const ack = await c.ack;
  assert.equal(ack.ok, true);
  assert.equal(ack.order.status, 'PENDING');
  const intruder = client(o.orderNo, 'token-palsu');
  assert.equal((await intruder.ack).ok, false);

  const forged = await t.req('/api/payments/klikqris/webhook', { method: 'POST', body: { ...mock.webhookBody(o.orderNo), signature: 'palsu' } });
  assert.equal(forged.status, 401);
  assert.equal((await read(o)).body.order.status, 'PENDING', 'webhook palsu tidak mengubah status');
  const wrongAmt = await t.req('/api/payments/klikqris/webhook', { method: 'POST', body: mock.webhookBody(o.orderNo, 'PAID', { total_amount: 1 }) });
  assert.equal(wrongAmt.status, 400);

  const ok = await t.req('/api/payments/klikqris/webhook', { method: 'POST', body: mock.webhookBody(o.orderNo) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.duplicate, false);
  const pushed = await until(() => c.events.find((e) => e.status === 'SUCCESS'));
  assert.ok(pushed.paidAt);

  const dups = await Promise.all([1, 2, 3, 4].map(() => t.req('/api/payments/klikqris/webhook', { method: 'POST', body: mock.webhookBody(o.orderNo) })));
  dups.forEach((d) => { assert.equal(d.status, 200); assert.equal(d.body.duplicate, true); });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(c.events.filter((e) => e.status === 'SUCCESS').length, 1, 'tidak ada event ganda');
  assert.equal(await stockNow(), stock0 - 1, 'stok berkurang tepat sekali');
  assert.equal(intruder.events.length, 0, 'klien tanpa token tidak menerima data order');
  assert.equal((await read(o)).body.order.status, 'SUCCESS');
});

test('webhook EXPIRED -> EXPIRED lewat realtime; pembayaran terlambat tetap dicatat; status tidak dibuat sendiri', async () => {
  const o = (await checkout()).body;
  const c = client(o.orderNo, o.token); await c.ack;
  await t.req('/api/payments/klikqris/webhook', { method: 'POST', body: mock.webhookBody(o.orderNo, 'EXPIRED') });
  await until(() => c.events.find((e) => e.status === 'EXPIRED'));
  const late = await t.req('/api/payments/klikqris/webhook', { method: 'POST', body: mock.webhookBody(o.orderNo, 'PAID') });
  assert.equal(late.body.duplicate, false);
  assert.equal((await read(o)).body.order.status, 'SUCCESS');
  const admin = (await a.get('/orders?q=' + o.orderNo)).body.items[0];
  assert.equal(admin.latePayment, true);
  const noop = await t.req('/api/payments/klikqris/webhook', { method: 'POST', body: mock.webhookBody(o.orderNo, 'REFUNDED') });
  assert.equal(noop.status, 200);
  assert.equal((await read(o)).body.order.status, 'SUCCESS');
});

test('fallback: webhook tidak datang -> worker mengecek status ke KlikQRIS dan halaman diperbarui', async () => {
  const o = (await checkout()).body;
  const c = client(o.orderNo, o.token); await c.ack;
  mock.setStatus(o.orderNo, 'SUCCESS');
  await until(() => c.events.find((e) => e.status === 'SUCCESS'), { timeout: 12_000 });
  assert.equal((await a.get('/orders?q=' + o.orderNo)).body.items[0].source, 'status-check');
});

test('KlikQRIS gagal membuat transaksi -> FAILED (status internal), tanpa QRIS, tanpa kebocoran detail', async () => {
  mock.state.failCreate = true;
  const r = await checkout();
  mock.state.failCreate = false;
  assert.equal(r.status, 201);
  const o = (await read(r.body)).body.order;
  assert.equal(o.status, 'FAILED');
  assert.equal(o.qrisUrl, null);
  assert.equal(JSON.stringify(o).includes('boom'), false);
});

test('Admin: ubah nomor WhatsApp tersinkron realtime; uji koneksi; stok habis menolak checkout', async () => {
  const pub = io(t.base, { transports: ['websocket'] }); sockets.push(pub);
  const got = new Promise((resolve) => pub.once('payment:settings', resolve));
  await new Promise((r) => pub.once('connect', r));
  await a.put('/payment-settings', settings({ waAdmin: '0899 000 111' }));
  assert.equal((await got).waAdmin, '62899000111');
  assert.equal((await a.post('/payment-settings/test')).status, 200);
  await a.put(`/products/${product.id}`, { name: product.name, category: product.category.id, price: 50000, stock: 0 });
  assert.equal((await checkout()).status, 409);
});
