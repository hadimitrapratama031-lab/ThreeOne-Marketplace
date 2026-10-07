import http from 'node:http';

/** KlikQRIS tiruan lokal: meniru bentuk request/respons di dokumentasi resmi (mode sandbox: /sandbox/qris/...). */
export async function startKlikqrisMock({ uniqueCode = 16 } = {}) {
  const txs = new Map();
  const state = { failCreate: false, creds: { apiKey: 'KEY-SB', merchantId: 'MRC-SB' }, calls: [] };
  const fmt = (n) => Number(n).toFixed(2);
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      state.calls.push(`${req.method} ${req.url}`);
      if (req.headers['x-api-key'] !== state.creds.apiKey || req.headers.id_merchant !== state.creds.merchantId) return send(401, { status: false, message: 'Unauthorized' });
      const url = new URL(req.url, 'http://x');
      if (req.method === 'POST' && url.pathname === '/sandbox/qris/create') {
        if (state.failCreate) return send(500, { status: false, message: 'boom' });
        const b = JSON.parse(raw);
        const tx = { order_id: b.order_id, amount: b.amount, uniq: uniqueCode, status: 'PENDING', signature: `sig_${b.order_id}_${Math.random().toString(36).slice(2)}`, callback_url: b.callback_url || '' };
        txs.set(b.order_id, tx);
        return send(200, { status: true, message: 'Transaction Created Successfully', data: {
          order_id: b.order_id, amount_uniq: fmt(uniqueCode), amount: fmt(b.amount), total_amount: fmt(b.amount + uniqueCode), status: 'PENDING',
          qris_url: `https://klikqris.com/storage/qris_api/qris_${b.order_id}.png`,
          qris_image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', report_url: 'https://klikqris.com/laporan-buyer/x',
          expired_at: '2026-10-05 11:41:25', paid_at: null, signature: tx.signature } });
      }
      const m = url.pathname.match(/^\/sandbox\/qris\/status\/(.+)$/);
      if (req.method === 'GET' && m) {
        const tx = txs.get(decodeURIComponent(m[1]));
        if (!tx) return send(404, { status: false, message: 'not found' });
        return send(200, { status: true, message: 'Transaction detail retrieved', data: { order_id: tx.order_id, status: tx.status, total_amount: fmt(tx.amount + tx.uniq), paid_at: tx.status === 'SUCCESS' ? '2026-10-05 10:41:25' : null } });
      }
      if (req.method === 'GET' && url.pathname === '/sandbox/qris/history') return send(200, { status: true, data: { data: [] } });
      send(404, { status: false, message: 'no route' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`, txs, state,
    setStatus: (id, status) => { txs.get(id).status = status; },
    webhookBody: (id, status = 'PAID', over = {}) => { const t = txs.get(id); return { order_id: id, status, amount: t.amount, total_amount: t.amount + t.uniq, payment_date: '2026-10-05 10:41:25', signature: t.signature, ...over }; },
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
