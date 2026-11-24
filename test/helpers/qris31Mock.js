import http from 'node:http';
import crypto from 'node:crypto';

export const QRIS31_KEY = 'KEY-31';
export const QRIS31_SECRET = 'whsec_test_secret_31';
const PNG64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * 31 QRIS tiruan lokal. Bentuk body/respons mengikuti ASUMSI di server/services/qris31.js (dokumentasi gateway belum memuat skema field),
 * jadi test ini memeriksa logika backend (autentikasi Bearer, HMAC, idempotensi, validasi nominal), bukan kecocokan dengan gateway asli.
 */
export async function startQris31Mock({ uniqueCode = 16 } = {}) {
  const txs = new Map();   // order_id -> tx
  const state = { failCreate: false, apiKey: QRIS31_KEY, blockScope: new Set(), calls: [], seq: 0 };
  const view = (tx) => ({ id: tx.id, order_id: tx.order_id, amount: tx.amount, unique_code: tx.uniq, total_amount: tx.amount + tx.uniq, status: tx.status, qris_image: PNG64, expires_at: '2099-01-01T00:00:00.000Z', paid_at: tx.status === 'PAID' ? '2026-10-05T10:41:25.000Z' : null });
  const byId = (id) => [...txs.values()].find((x) => x.id === id);
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const url = new URL(req.url, 'http://x');
      state.calls.push(`${req.method} ${url.pathname}`);
      if (req.headers.authorization !== `Bearer ${state.apiKey}`) return send(401, { error: { code: 'UNAUTHORIZED', message: 'API key tidak valid' } });
      if (state.blockScope.has(`${req.method} ${url.pathname}`) || state.blockScope.has(url.pathname)) return send(403, { error: { code: 'INSUFFICIENT_SCOPE', message: 'scope kurang' } });
      if (req.method === 'POST' && url.pathname === '/v1/transactions') {
        if (state.failCreate) return send(500, { error: { message: 'boom' } });
        const b = JSON.parse(raw);
        state.seq += 1;
        const tx = { id: `txn_${state.seq}`, order_id: b.order_id, amount: b.amount, uniq: uniqueCode, status: 'PENDING' };
        txs.set(b.order_id, tx);
        return send(201, { data: view(tx) });
      }
      let m = url.pathname.match(/^\/v1\/transactions\/by-order\/(.+)$/);
      if (req.method === 'GET' && m) { const tx = txs.get(decodeURIComponent(m[1])); return tx ? send(200, { data: view(tx) }) : send(404, { error: { code: 'NOT_FOUND', message: 'tidak ada' } }); }
      m = url.pathname.match(/^\/v1\/transactions\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && m) {
        const tx = byId(decodeURIComponent(m[1]));
        if (!tx) return send(404, { error: { code: 'NOT_FOUND' } });
        if (tx.status !== 'PENDING') return send(409, { error: { code: 'NOT_PENDING', message: 'bukan pending' } });
        tx.status = 'CANCELLED';
        return send(200, { data: view(tx) });
      }
      m = url.pathname.match(/^\/v1\/transactions\/([^/]+)$/);
      if (req.method === 'GET' && m) { const tx = byId(decodeURIComponent(m[1])); return tx ? send(200, { data: view(tx) }) : send(404, { error: { code: 'NOT_FOUND' } }); }
      if (req.method === 'GET' && url.pathname === '/v1/transactions') return send(200, { data: [...txs.values()].map(view) });
      if (req.method === 'GET' && url.pathname === '/v1/qris') return send(200, { data: { active: true } });
      send(404, { error: { code: 'NO_ROUTE' } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const sign = (raw, secret = QRIS31_SECRET) => crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return {
    url: `http://127.0.0.1:${server.address().port}`, txs, state,
    setStatus: (orderNo, status) => { txs.get(orderNo).status = status; },
    sign,
    webhookBody: (orderNo, status = 'PAID', over = {}) => { const t = txs.get(orderNo); return { event: `transaction.${String(status).toLowerCase()}`, data: { id: t.id, order_id: orderNo, status, total_amount: t.amount + t.uniq, paid_at: '2026-10-05T10:41:25.000Z', ...over } }; },
    /** Kirim webhook bertanda tangan ke backend. Status transaksi di gateway tiruan ikut diatur lebih dulu (gateway selalu benar). */
    async hook(t, orderNo, status = 'PAID', { over = {}, signature, setRemote = true, rawOverride } = {}) {
      if (setRemote && txs.has(orderNo)) txs.get(orderNo).status = status;
      const raw = rawOverride ?? JSON.stringify(this.webhookBody(orderNo, status, over));
      const res = await fetch(`${t.base}/api/payments/31qris/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': signature ?? sign(raw) }, body: raw });
      const text = await res.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      return { status: res.status, body };
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Fonnte + Resend tiruan lokal: meniru bentuk request/respons yang dipakai project lama (form /send, JSON /emails). */
export async function startProvidersMock() {
  const state = { wa: [], mail: [], failWa: 0, failMail: 0, permanentWa: false, noIdWa: false, domains: [{ id: 'd1', name: 'toko.example', status: 'verified', region: 'ap-northeast-1', records: [{ record: 'DKIM', type: 'TXT', name: 'resend._domainkey', value: 'p=abc', status: 'verified' }] }] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'POST' && req.url === '/send') {
        if (req.headers.authorization !== 'FONNTE-TOKEN') return send(200, { status: false, reason: 'invalid token' });
        const f = Object.fromEntries(new URLSearchParams(raw));
        if (state.permanentWa) return send(200, { status: false, reason: 'target invalid' });
        if (state.failWa > 0) { state.failWa -= 1; return send(503, {}); }
        state.wa.push({ target: f.target, message: f.message });
        return send(200, state.noIdWa ? { status: true, detail: 'queued' } : { status: true, id: [`wa-${state.wa.length}`], detail: 'success! message in queue' });
      }
      if (req.url.startsWith('/emails') || req.url.startsWith('/domains')) {
        if (req.headers.authorization !== 'Bearer re_KEY') return send(401, { name: 'validation_error', message: 'API key is invalid' });
        if (req.method === 'POST' && req.url === '/emails') {
          const b = JSON.parse(raw);
          if (state.failMail > 0) { state.failMail -= 1; return send(500, { message: 'oops' }); }
          state.mail.push(b);
          return send(200, { id: `mail-${state.mail.length}` });
        }
        if (req.url === '/domains') return send(200, { data: state.domains.map(({ id, name, status }) => ({ id, name, status })) });
        const m = req.url.match(/^\/domains\/(.+)$/);
        if (m) return send(200, state.domains.find((d) => d.id === m[1]));
      }
      send(404, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise((r) => server.close(r)) };
}
