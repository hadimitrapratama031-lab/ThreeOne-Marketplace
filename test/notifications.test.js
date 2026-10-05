import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { io } from 'socket.io-client';
import { boot, until } from './helpers/boot.js';
import { startKlikqrisMock, startProvidersMock } from './helpers/klikqrisMock.js';

let t; let a; let gw; let prov; let product; const sockets = [];
const SECRET = `whsec_${Buffer.from('resend-signing-secret').toString('base64')}`;
const BUYER = { name: 'Budi Santoso', email: 'Budi@Example.com', whatsapp: '0812 3456 7890' };

before(async () => {
  gw = await startKlikqrisMock();
  prov = await startProvidersMock();
  Object.assign(process.env, { KLIKQRIS_BASE_URL: gw.url, FONNTE_BASE_URL: prov.url, RESEND_BASE_URL: prov.url, NOTIFICATION_BACKOFF_MS: '10,10' });
  t = await boot();
  a = await t.admin();
  const cat = (await a.post('/categories', { name: 'Game' })).body.item;
  product = (await a.post('/products', { name: 'Game Notifikasi', category: cat.id, price: 50000, stock: 50 })).body.item;
  await a.put('/payment-settings', { mode: 'sandbox', sandbox: { merchantId: 'MRC-SB', apiKey: 'KEY-SB' }, production: {}, waAdmin: '0811 2222 3333' });
});
after(async () => { sockets.forEach((s) => s.close()); await t.stop(); await gw.close(); await prov.close(); });

const checkout = (over = {}) => t.req('/api/orders', { method: 'POST', body: { productId: product.productId, ...BUYER, ...over } });
const pay = (id, status = 'PAID') => t.req('/api/payments/klikqris/webhook', { method: 'POST', body: gw.webhookBody(id, status) });
const logs = async (orderNo) => (await a.get(`/notifications?orderNo=${orderNo}&limit=50`)).body.items;
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const resetProv = () => { prov.state.wa.length = 0; prov.state.mail.length = 0; prov.state.failWa = 0; prov.state.failMail = 0; prov.state.permanentWa = false; prov.state.noIdWa = false; };

const fonnteBody = (o = {}) => ({ enabled: true, token: 'FONNTE-TOKEN', testTarget: '0812 3456 7890', ...o });
const resendBody = (o = {}) => ({ enabled: true, apiKey: 're_KEY', fromEmail: 'noreply@toko.example', fromName: 'Toko Uji', replyTo: 'admin@toko.example', testTo: 'saya@toko.example', ...o });

test('pengaturan: rahasia terenkripsi & tidak pernah kembali; domain gratisan & aktivasi tanpa kredensial ditolak', async () => {
  assert.equal((await a.put('/integrations/fonnte', fonnteBody({ token: '' }))).status, 422, 'aktif tanpa token ditolak');
  assert.equal((await a.put('/integrations/resend', resendBody({ fromEmail: 'toko@gmail.com' }))).status, 422, 'Gmail ditolak sebagai pengirim');
  const f = await a.put('/integrations/fonnte', fonnteBody());
  const r = await a.put('/integrations/resend', resendBody({ webhookSecret: SECRET }));
  assert.equal(f.status, 200); assert.equal(r.status, 200);
  const all = JSON.stringify((await a.get('/integrations')).body);
  for (const secret of ['FONNTE-TOKEN', 're_KEY', SECRET]) assert.equal(all.includes(secret), false, `${secret} bocor ke browser`);
  const v = (await a.get('/integrations')).body.settings;
  assert.equal(v.fonnte.tokenSet, true); assert.equal(v.resend.apiKeySet, true);
  assert.match(v.resend.webhookUrl, /\/api\/webhooks\/resend$/);
  assert.equal((await t.req('/api/admin/integrations')).status, 401);
  assert.equal((await t.req('/api/public/bootstrap')).body.settings.integrations, undefined);
});

test('uji koneksi: pesan WhatsApp & email uji benar-benar sampai ke provider; hasil tercatat', async () => {
  resetProv();
  const w = await a.post('/integrations/fonnte/test', { testTarget: '0812 3456 7890' });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.equal(prov.state.wa[0].target, '6281234567890');
  const m = await a.post('/integrations/resend/test', { testTo: 'saya@toko.example' });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(prov.state.mail[0].from, 'Toko Uji <noreply@toko.example>');
  assert.deepEqual(prov.state.mail[0].to, ['saya@toko.example']);
  assert.equal((await a.get('/integrations')).body.settings.fonnte.lastTest.status, 'success');
  const dom = await a.get('/integrations/resend/domain-status');
  assert.equal(dom.body.domains[0].name, 'toko.example');
  assert.equal(dom.body.domains[0].isSendingDomain, true);
  assert.equal(dom.body.domains[0].records[0].type, 'TXT');
});

test('orderCreated: tepat satu WhatsApp + satu Email dengan data order sebenarnya', async () => {
  resetProv();
  const r = await checkout();
  assert.equal(r.status, 201);
  const orderNo = r.body.orderNo;
  await until(async () => (await logs(orderNo)).filter((l) => l.status === 'sent').length === 2);
  assert.equal(prov.state.wa.length, 1); assert.equal(prov.state.mail.length, 1);
  const wa = prov.state.wa[0];
  assert.equal(wa.target, '6281234567890');
  for (const must of [orderNo, 'Game Notifikasi', 'Budi Santoso', 'Rp 50.016', 'QRIS']) assert.ok(wa.message.includes(must), `WA memuat ${must}`);
  const mail = prov.state.mail[0];
  assert.deepEqual(mail.to, ['budi@example.com']);
  assert.equal(mail.headers['X-Entity-Ref-ID'], orderNo);
  assert.equal(mail.reply_to, 'admin@toko.example');
  assert.ok(mail.subject.includes(orderNo));
  assert.ok(mail.html.includes('Game Notifikasi') && mail.html.includes('Rp 50.016'));
  assert.ok(mail.text && mail.text.includes(orderNo), 'ada versi text/plain');
  const l = await logs(orderNo);
  assert.deepEqual(l.map((x) => x.event).sort(), ['orderCreated', 'orderCreated']);
});

test('paymentSuccess: webhook ganda & dibaca ulang tidak mengirim ulang (idempoten)', async () => {
  resetProv();
  const { orderNo } = (await checkout({ clientKey: 'notifkey00000001' })).body;
  await until(() => prov.state.wa.length === 1 && prov.state.mail.length === 1);
  await checkout({ clientKey: 'notifkey00000001' });                       // kirim ulang checkout yang sama
  await Promise.all([1, 2, 3, 4, 5].map(() => pay(orderNo)));
  await until(() => prov.state.wa.length === 2 && prov.state.mail.length === 2);
  await t.req(`/api/orders/${orderNo}`);                                   // refresh / reconnect halaman
  await pay(orderNo); await settle(400);
  assert.equal(prov.state.wa.length, 2, 'WA: orderCreated + paymentSuccess saja');
  assert.equal(prov.state.mail.length, 2, 'Email: orderCreated + paymentSuccess saja');
  assert.ok(prov.state.wa[1].message.includes('Lunas'));
  assert.ok(prov.state.wa[1].message.includes('/payment.html?order='), 'tautan invoice memuat halaman payment');
  const events = (await logs(orderNo)).map((x) => `${x.event}:${x.channel}:${x.status}`).sort();
  assert.deepEqual(events, ['orderCreated:email:sent', 'orderCreated:whatsapp:sent', 'paymentSuccess:email:sent', 'paymentSuccess:whatsapp:sent']);
});

test('paymentExpired & paymentFailed memicu notifikasi masing-masing', async () => {
  resetProv();
  const exp = (await checkout()).body.orderNo;
  await until(() => prov.state.wa.length === 1);
  await pay(exp, 'EXPIRED');
  await until(() => prov.state.wa.length === 2);
  assert.ok(prov.state.wa[1].message.toLowerCase().includes('kadaluwarsa'));

  resetProv();
  gw.state.failCreate = true;
  const failed = (await checkout()).body.orderNo;
  gw.state.failCreate = false;
  await until(() => prov.state.wa.length === 1 && prov.state.mail.length === 1);
  const ev = (await logs(failed)).map((x) => x.event);
  assert.ok(ev.every((e) => e === 'paymentFailed'), 'order gagal dibuat hanya mengirim paymentFailed (tidak ada orderCreated)');
});

test('kegagalan provider: retry otomatis 3x, gagal permanen tidak diulang, balasan tanpa id dianggap gagal, retry manual', async () => {
  resetProv();
  prov.state.failWa = 99;
  const o1 = (await checkout()).body.orderNo;
  await until(async () => (await logs(o1)).some((l) => l.channel === 'whatsapp' && l.status === 'failed'));
  const w1 = (await logs(o1)).find((l) => l.channel === 'whatsapp');
  assert.equal(w1.attempts, 3);
  assert.equal((await logs(o1)).find((l) => l.channel === 'email').status, 'sent', 'kegagalan WA tidak mengganggu Email');
  prov.state.failWa = 0;
  const rr = await a.post(`/notifications/${w1.id}/retry`);
  assert.equal(rr.status, 200, JSON.stringify(rr.body));
  assert.equal((await logs(o1)).find((l) => l.channel === 'whatsapp').status, 'sent');
  assert.equal((await a.post(`/notifications/${w1.id}/retry`)).status, 409, 'yang sudah terkirim tidak dikirim ulang');

  resetProv();
  prov.state.permanentWa = true;
  const o2 = (await checkout()).body.orderNo;
  await until(async () => (await logs(o2)).some((l) => l.channel === 'whatsapp' && l.status === 'failed'));
  assert.equal((await logs(o2)).find((l) => l.channel === 'whatsapp').attempts, 1, 'gagal permanen tidak di-retry');

  resetProv();
  prov.state.noIdWa = true;
  const o3 = (await checkout()).body.orderNo;
  await until(async () => (await logs(o3)).some((l) => l.channel === 'whatsapp' && l.status === 'failed'));
  assert.match((await logs(o3)).find((l) => l.channel === 'whatsapp').error, /tanpa id pesan/);
  resetProv();
});

test('saklar Admin: kejadian & kanal yang dimatikan tidak mengirim apa pun', async () => {
  resetProv();
  await a.put('/integrations/notifications', { whatsappEnabled: true, emailEnabled: false, events: { orderCreated: false } });
  const o = (await checkout()).body.orderNo;
  await settle(400);
  assert.equal(prov.state.wa.length + prov.state.mail.length, 0, 'orderCreated dimatikan');
  await pay(o);
  await until(() => prov.state.wa.length === 1);
  await settle(300);
  assert.equal(prov.state.mail.length, 0, 'kanal Email dimatikan');
  await a.put('/integrations/notifications', { whatsappEnabled: true, emailEnabled: true, events: { orderCreated: true } });
});

test('template kustom dipakai bila diisi; kosong = template bawaan; pratinjau tidak mengirim', async () => {
  resetProv();
  await a.put('/integrations/templates', { whatsapp: { orderCreated: 'Halo {{customer_name}}, pesanan {{order_code}} total {{total}}' } });
  const o = (await checkout()).body.orderNo;
  await until(() => prov.state.wa.length === 1);
  assert.equal(prov.state.wa[0].message, `Halo Budi Santoso, pesanan ${o} total Rp 50.016`);
  const sent = prov.state.wa.length + prov.state.mail.length;
  const p = (await a.get('/integrations/preview')).body;
  assert.equal(p.usingSample, true);
  assert.equal(p.events.length, 4);
  assert.equal(prov.state.wa.length + prov.state.mail.length, sent, 'pratinjau tidak memanggil provider');
  await a.put('/integrations/templates', { whatsapp: { orderCreated: '' } });
});

test('webhook Resend: signature Svix divalidasi; deliveryStatus tersimpan; replay & palsu ditolak', async () => {
  resetProv();
  const o = (await checkout()).body.orderNo;
  await until(async () => (await logs(o)).filter((l) => l.status === 'sent').length === 2);
  const mailLog = (await logs(o)).find((l) => l.channel === 'email');
  const raw = JSON.stringify({ type: 'email.delivered', data: { email_id: 'mail-' + prov.state.mail.length } });
  const sign = (ts, body = raw, id = 'msg_1') => `v1,${crypto.createHmac('sha256', Buffer.from(SECRET.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64')}`;
  const post = (ts, sig, body = raw) => t.req('/api/webhooks/resend', { method: 'POST', headers: { 'content-type': 'application/json', 'svix-id': 'msg_1', 'svix-timestamp': String(ts), 'svix-signature': sig }, form: body });
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await post(now, 'v1,palsu')).status, 401);
  assert.equal((await post(now - 3600, sign(now - 3600))).status, 401, 'timestamp lama (replay) ditolak');
  assert.equal((await post(now, sign(now))).status, 200);
  assert.equal((await logs(o)).find((l) => l.id === mailLog.id).deliveryStatus, 'delivered');
});

test('realtime: perubahan setting & log notifikasi tersinkron lewat Socket.IO admin yang sudah ada', async () => {
  const adm = io(t.base + '/admin', { transports: ['websocket'], extraHeaders: { cookie: a.cookie } }); sockets.push(adm);
  await new Promise((r) => adm.once('connect', r));
  const upd = new Promise((r) => adm.once('integrations:update', r));
  await a.put('/integrations/resend', resendBody({ fromName: 'Toko Baru' }));
  assert.equal((await upd).resend.fromName, 'Toko Baru');
  assert.equal(JSON.stringify(await upd).includes('re_KEY'), false);
  const got = new Promise((r) => adm.once('notification:log', r));
  resetProv();
  await checkout();
  assert.ok((await got).orderCode);
  await until(() => prov.state.mail.length === 1);
  assert.equal(prov.state.mail[0].from, 'Toko Baru <noreply@toko.example>', 'pengiriman berikutnya langsung memakai setelan baru');
});
