import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, PNG } from './helpers/boot.js';
import { imageSize } from '../server/lib/sniff.js';
import { injectMeta } from '../server/lib/meta.js';

let t; let a;
before(async () => { t = await boot(); a = await t.admin(); });
after(async () => { await t.stop(); });

const metaOf = (html, attr, name) => new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`).exec(html)?.[1];
const page = async (path) => (await fetch(t.base + path, { headers: { 'user-agent': 'WhatsApp/2.23 A' } })).text();

test('imageSize: PNG & JPEG dibaca dari header', () => {
  assert.deepEqual(imageSize(PNG), { width: 1, height: 1 });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 0x11, 8, 0x02, 0x76, 0x04, 0xb0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpg), { width: 1200, height: 630 });
});

test('injectMeta: pola pengganti "$&" / "$\'" di judul/deskripsi tidak merusak HTML', () => {
  const html = injectMeta('<html><head><title>x</title></head><body>BODY</body></html>',
    { title: "Akun $& Steam $' Murah", description: 'Harga $` terbaik', url: 'https://a.b/', siteName: 'S', type: 'website', image: '' });
  assert.equal((html.match(/<\/head>/g) || []).length, 1);
  assert.equal((html.match(/<body>BODY<\/body>/g) || []).length, 1);
  assert.match(html, /<title>Akun \$&amp; Steam \$' Murah<\/title>/);
});

test('Social Share: HTML awal (tanpa JavaScript) memuat og:/twitter: lengkap, banner global sama, teks per halaman', async () => {
  const up = await a.upload(PNG, 'social', 'banner.png');
  assert.equal(up.status, 201);
  const put = await a.put('/settings/socialShare', { banner: { key: up.body.asset.key } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const banner = put.body.value.banner;
  assert.equal(banner.width, 1);   // ukuran asli tercatat saat upload, bukan angka tebakan

  const home = await page('/');
  const rating = await page('/rating');
  const track = await page('/cek-pesanan');
  for (const html of [home, rating, track]) {
    for (const [attr, name] of [['property', 'og:title'], ['property', 'og:description'], ['property', 'og:image'], ['property', 'og:image:secure_url'],
      ['property', 'og:image:type'], ['property', 'og:image:width'], ['property', 'og:image:height'], ['property', 'og:url'], ['property', 'og:type'],
      ['property', 'og:site_name'], ['name', 'twitter:card'], ['name', 'twitter:title'], ['name', 'twitter:description'], ['name', 'twitter:image'],
      ['name', 'twitter:url'], ['name', 'description']]) {
      assert.ok(metaOf(html, attr, name), `${name} harus ada`);
    }
    assert.equal(metaOf(html, 'property', 'og:image'), banner.url, 'banner global sama di semua halaman');
    assert.equal(metaOf(html, 'property', 'og:image:type'), 'image/png');
  }
  assert.notEqual(metaOf(rating, 'property', 'og:title'), metaOf(home, 'property', 'og:title'));
  assert.notEqual(metaOf(track, 'property', 'og:description'), metaOf(rating, 'property', 'og:description'));
  assert.match(metaOf(rating, 'property', 'og:url'), /\/rating$/);
  assert.match(metaOf(track, 'property', 'og:url'), /\/cek-pesanan$/);

  // URL banner benar-benar bisa diambil tanpa login/cookie, HTTP 200, Content-Type image
  const img = await fetch(banner.url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
});

test('Social Share: Product Detail memakai nama + deskripsi produk; halaman order tidak memuat data order', async () => {
  const cat = (await a.post('/categories', { name: 'Cat SS' })).body.item;
  const p = (await a.post('/products', { name: 'Akun Steam $& Uji', category: cat.id, price: 10000, stock: 3, description: 'Baris satu\n\nBaris <b>dua</b>' })).body.item;
  const html = await page(`/product/${p.productId ?? p.id}`);
  assert.match(metaOf(html, 'property', 'og:title'), /Akun Steam \$&amp; Uji/);
  assert.equal(metaOf(html, 'property', 'og:description'), 'Baris satu Baris dua');
  assert.equal(metaOf(html, 'property', 'og:type'), 'product');

  const pay = await page('/payment?order=MP-SECRET-123&t=rahasia');
  assert.equal(pay.includes('MP-SECRET-123'), false);
  assert.equal(pay.includes('rahasia'), false);
});

test('Social Share: banner diganti dari Admin -> halaman langsung memakai URL baru', async () => {
  const up = await a.upload(PNG, 'social', 'banner2.png');
  const put = await a.put('/settings/socialShare', { banner: { key: up.body.asset.key } });
  assert.equal(put.status, 200);
  const html = await page('/rating');
  assert.equal(metaOf(html, 'property', 'og:image'), put.body.value.banner.url);
});

test('Social Share: banner besar (>280 KB) otomatis dibuatkan salinan og:image ringan; file asli tetap utuh', async () => {
  const sharp = (await import('sharp')).default;
  const noise = (await import('node:crypto')).randomBytes(1200 * 630 * 3);
  const big = await sharp(noise, { raw: { width: 1200, height: 630, channels: 3 } }).png().toBuffer();
  assert.ok(big.length > 280 * 1024, 'bahan uji harus lebih besar dari batas');
  const up = await a.upload(big, 'social', 'besar.png');
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const put = await a.put('/settings/socialShare', { banner: { key: up.body.asset.key } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.value.banner.url.endsWith('.png'), true, 'file asli tetap tersimpan');

  const html = await page('/');
  const og = metaOf(html, 'property', 'og:image');
  assert.match(og, /-og\.jpg$/);
  assert.equal(metaOf(html, 'property', 'og:image:type'), 'image/jpeg');
  assert.equal(metaOf(html, 'property', 'twitter:image') ?? metaOf(html, 'name', 'twitter:image'), og);
  const img = await fetch(og);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.ok((await img.arrayBuffer()).byteLength <= 280 * 1024);
});
