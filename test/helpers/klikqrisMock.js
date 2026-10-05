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
          qris_url: `https://klikqris.com/storage/qris_api/qris_${b.order_id}.png`, report_url: 'https://klikqris.com/laporan-buyer/x',
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
