import http from 'node:http';

/** Server S3 sederhana (path-style) untuk menguji alur R2: PUT / HEAD / GET / DELETE. Bukan Cloudflare R2 asli. */
export function startS3Mock() {
  const store = new Map(); // "bucket/key" -> { body, type }
  const log = [];
  const fail = { delete: false, put: false };   // delete: R2 gagal menghapus; put: R2 menolak menulis (403 AccessDenied, seperti token read-only)
  const server = http.createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).slice(1);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      log.push(`${req.method} ${path}`);
      if (req.method === 'PUT' && fail.put) {
        res.writeHead(403, { 'Content-Type': 'application/xml' })
          .end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>');
      } else if (req.method === 'PUT') {
        store.set(path, { body: Buffer.concat(chunks), type: req.headers['content-type'] || 'application/octet-stream' });
        res.writeHead(200, { ETag: '"mock"' }).end();
      } else if (req.method === 'HEAD' || req.method === 'GET') {
        const o = store.get(path);
        if (!o) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Length': o.body.length, 'Content-Type': o.type, 'Access-Control-Allow-Origin': '*' });
        res.end(req.method === 'GET' ? o.body : undefined);
      } else if (req.method === 'DELETE') {
        if (fail.delete) { res.writeHead(500).end(); return; }
        store.delete(path);
        res.writeHead(204).end();
      } else res.writeHead(405).end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve({ port, store, log, fail, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
  }));
}
