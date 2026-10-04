import { randomBytes } from 'node:crypto';
import { startS3Mock } from './s3mock.js';

// PNG 1x1 valid
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
export const ADMIN = { email: 'admin@example.com', password: 'correct-horse-battery' };

// mongodb://host:port[/db][?opts] -> mongodb://host:port/<name>[?opts]  (mendukung banyak host / mongodb+srv)
function withDb(uri, name) {
  const m = uri.match(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/[^?]*)?(\?.*)?$/);
  if (!m) throw new Error('TEST_MONGODB_URI tidak valid');
  return `${m[1]}/${name}${m[2] || ''}`;
}

/** Jalankan server nyata (Express + Socket.IO + Mongoose) dengan R2 tiruan lokal. DB unik per proses tes. */
export async function boot({ seed = false, dbName } = {}) {
  const s3 = await startS3Mock();
  const base = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017';
  const name = dbName || `mp_test_${randomBytes(4).toString('hex')}`;
  Object.assign(process.env, {
    NODE_ENV: 'test', MONGODB_URI: withDb(base, name), APP_SECRET: 'test-secret-'.repeat(4),
    ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password, SEED_DEMO: seed ? 'true' : 'false',
    R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'AKIATESTKEY', R2_SECRET_ACCESS_KEY: 'TOP-SECRET-R2-VALUE', R2_BUCKET_NAME: 'bkt',
    R2_ENDPOINT: s3.url, R2_FORCE_PATH_STYLE: 'true', R2_PUBLIC_URL: `${s3.url}/bkt`,
  });
  const { start } = await import('../../server/index.js');
  const mongoose = (await import('mongoose')).default;
  let app = await start({ port: 0, quiet: true });

  const ctx = {
    s3, name,
    get port() { return app.port; },
    get base() { return `http://127.0.0.1:${app.port}`; },
    async restart() { await app.stop(); app = await start({ port: 0, quiet: true }); },
    async stop() {
      await app.stop();
      await mongoose.connect(process.env.MONGODB_URI);
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
      await s3.close();
    },
    /** fetch ke server; mengembalikan { status, body, res } */
    async req(path, { method = 'GET', body, cookie, headers = {}, form } = {}) {
      const res = await fetch(ctx.base + path, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
        body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
      });
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, body: json, res };
    },
    async login() {
      const r = await ctx.req('/api/admin/auth/login', { method: 'POST', body: ADMIN });
      if (r.status !== 200) throw new Error('login gagal: ' + JSON.stringify(r.body));
      return r.res.headers.get('set-cookie').split(';')[0];
    },
    /** klien admin terautentikasi */
    async admin() {
      const cookie = await ctx.login();
      const call = (method) => (path, body) => ctx.req('/api/admin' + path, { method, body, cookie });
      return {
        cookie, get: call('GET'), post: call('POST'), put: call('PUT'), patch: call('PATCH'), del: call('DELETE'),
        async upload(buffer = PNG, folder = 'products', name = 'a.png') {
          const form = new FormData();
          form.append('folder', folder);
          form.append('file', new Blob([buffer]), name);
          return ctx.req('/api/admin/media', { method: 'POST', cookie, form });
        },
      };
    },
    inBucket: (key) => ctx.s3.store.has(`bkt/${key}`),
  };
  return ctx;
}

export const until = async (fn, { timeout = 3000, step = 25 } = {}) => {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('until(): kondisi tidak terpenuhi');
    await new Promise((r) => setTimeout(r, step));
  }
};
