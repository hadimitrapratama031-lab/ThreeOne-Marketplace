/**
 * Migrasi data dari project Marketplace LAMA (MongoDB + Cloudflare R2) ke project baru (MongoDB + R2 baru).
 *
 *   node scripts/migrate-from-old.js            → DRY-RUN: hanya laporan (juga memastikan gambar lama bisa ditemukan)
 *   node scripts/migrate-from-old.js --apply    → tulis ke database & R2 baru (MONGODB_URI + R2_* di .env)
 *
 * Sumber lama dibaca dari OLD_MONGODB_URI (+ OLD_MONGODB_DB bila URI tanpa nama database) dan OLD_R2_* — lihat scripts/README.md.
 *
 * Yang dimigrasi:
 *   • Kategori : nama, urutan, aktif/nonaktif.
 *   • Produk   : nama, harga, stok, status, kategori, DESKRIPSI (shortDescription → Deskripsi singkat, description → Tentang produk)
 *                dan SEMUA GAMBAR (utama + tambahan) yang disalin dari R2 lama ke R2 baru, terdaftar sebagai aset produk.
 *                Produk baru bernama sama (tanpa peduli huruf) hanya DIPERBARUI harga/stok/status/kategori-nya; deskripsi diisi bila masih
 *                kosong; gambar hanya diganti bila produk itu belum punya gambar atau gambarnya semua hasil migrasi.
 *   • Pesanan  : HANYA pesanan yang sukses (dibayar). Nama, email, WhatsApp, produk, nominal, waktu, mode sandbox/production.
 *                Tidak mengubah stok, tidak mengirim notifikasi. (--all-orders: impor semua status seperti versi sebelumnya.)
 *   • Terjual  : angka terjual per produk di project lama dipertahankan. Project baru menghitung Terjual dari jumlah pesanan sukses,
 *                jadi selisihnya (mis. pesanan lama dengan quantity > 1) disimpan di Product.soldAdjust.
 *   • Rating   : bintang, ulasan, nama, tanggal. approved→tayang; hidden/pending→tersembunyi. Tanpa produk = ulasan umum.
 *
 * Aman dijalankan berulang (tidak membuat data/gambar dobel).
 * Opsi: --apply --verbose --skip-orders --skip-reviews --skip-images --all-orders --old-uri=… --old-db=…
 */
import mongoose from 'mongoose';
import { config, r2Configured } from '../server/config/env.js';
import { Product, Category, Review, Order, Asset, nextSeq } from '../server/models/index.js';
import { normalizeWhatsapp } from '../server/lib/phone.js';
import { putObject, headObject, publicUrl, probeR2 } from '../server/lib/r2.js';
import { sniff } from '../server/lib/sniff.js';
import { parseArgs, line, rowOut, hostOf } from './_common.js';
import { escapeRegex, legacyStatusLabel, mapOrderStatus, mapReviewStatus, cleanName, cleanText, makeBlurb, legacyImageRefs, isLegacyKey, toInt, normalizeWa, dbTarget } from './legacyMap.js';
import { readOldR2Env, createOldSource } from './_oldR2.js';
import { migrateProductImages } from './_legacyImages.js';

const { flags, values } = parseArgs();
const APPLY = flags.has('apply');
const VERBOSE = flags.has('verbose');
const SKIP_IMAGES = flags.has('skip-images');
const ALL_ORDERS = flags.has('all-orders');

let old = null;
const bye = async (code, msg) => {
  if (msg) console.error(msg);
  await old?.close().catch(() => {}); await mongoose.disconnect().catch(() => {});
  process.exit(code);
};

/* ---- Pemeriksaan awal ---- */
const oldUri = values['old-uri'] || process.env.OLD_MONGODB_URI;
if (!oldUri) await bye(1, 'Isi OLD_MONGODB_URI (connection string database LAMA).');
const uriDb = (String(oldUri).match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/) || [])[1] || '';
const oldDbName = values['old-db'] || process.env.OLD_MONGODB_DB || uriDb;
if (!oldDbName) await bye(1, 'Nama database lama belum diketahui. Tulis di URI (…mongodb.net/NAMA_DB?appName=…) atau isi OLD_MONGODB_DB / --old-db=NAMA.\nCatatan: project lama yang URI-nya TIDAK memuat nama database menyimpan datanya di database bernama "test" — pakai OLD_MONGODB_DB=test.');
if (!config.mongoUri) await bye(1, 'MONGODB_URI (database BARU) belum diisi di .env');

const r2old = readOldR2Env();
if (!SKIP_IMAGES && r2old.any && !r2old.complete) await bye(1, `OLD_R2_* belum lengkap, kurang: ${r2old.missing.join(', ')}. Lengkapi, atau hapus semuanya agar gambar diunduh lewat URL publik lama.`);
if (!SKIP_IMAGES && r2old.complete && r2old.endpoint === config.r2.endpoint && r2old.bucket === config.r2.bucket) await bye(1, 'OLD_R2_* menunjuk bucket yang sama dengan R2 baru. Dibatalkan.');

await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10_000 });
if (dbTarget(oldUri, oldDbName) === dbTarget(config.mongoUri, mongoose.connection.name)) await bye(1, 'Database lama sama dengan database baru (MONGODB_URI). Dibatalkan agar data tidak tertimpa.');
old = await mongoose.createConnection(oldUri, { serverSelectionTimeoutMS: 10_000, dbName: oldDbName }).asPromise();
const read = (name, sort = { _id: 1 }) => old.db.collection(name).find({}).sort(sort).toArray();

const oldCount = Object.fromEntries(await Promise.all(['categories', 'products', 'orders', 'ratings'].map(async (c) => [c, await old.db.collection(c).countDocuments({})])));
if (!oldCount.categories && !oldCount.products && !oldCount.orders) {
  const names = (await old.db.listCollections().toArray()).map((c) => c.name);
  await bye(1, `Database lama "${oldDbName}" kosong (tidak ada kategori/produk/pesanan). Koleksi yang ada: ${names.join(', ') || '(tidak ada)'}.\nPeriksa nama database (OLD_MONGODB_DB).`);
}

let source = null; let imgDeps = null;
if (!SKIP_IMAGES) {
  source = createOldSource(r2old);
  const chk = await source.check();
  if (!chk.ok) await bye(1, chk.message);
  if (APPLY) {
    if (!r2Configured()) await bye(1, 'R2 baru belum lengkap di .env (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL). Lengkapi, atau jalankan dengan --skip-images.');
    const probe = await probeR2();   // uji nyata tulis/baca/hapus di bucket baru SEBELUM ada yang ditulis ke database
    if (!probe.ok) await bye(1, 'R2 baru belum bisa dipakai untuk menulis (lihat DIAGNOSA di atas). Tidak ada yang dimigrasi.');
  }
  imgDeps = {
    source, sniff, putObject, headObject, publicUrl,
    findAsset: (marker, ownerId) => Asset.findOne({ originalName: marker, 'owner.type': 'product', 'owner.id': String(ownerId) }).lean(),
    saveAsset: ({ ownerId, ...a }) => Asset.findOneAndUpdate({ key: a.key }, { $set: { ...a, status: 'used', owner: { type: 'product', id: String(ownerId) } } }, { upsert: true, new: true }),
  };
}

const rep = {
  cat: { created: 0, existing: 0, skipped: [] },
  prod: { created: 0, updated: 0, skipped: [], textTrimmed: 0, withText: 0 },
  img: { refs: 0, found: 0, copied: 0, reused: 0, failed: [], noImage: 0, keptExisting: 0 },
  ord: { created: 0, existing: 0, repaired: 0, noProduct: 0, total: 0, notSuccess: 0, skipped: [], buyers: new Set(), byStatus: {}, legacy: {} },
  rev: { created: 0, existing: 0, skipped: [] },
  sold: [],
};

/* ---- Kategori ---- */
const catMap = new Map();
for (const c of await read('categories', { sortOrder: 1, _id: 1 })) {
  const name = cleanName(c.name, 40);
  if (name.length < 2) { rep.cat.skipped.push(`"${c.name}" (nama kurang dari 2 karakter)`); continue; }
  const nameKey = name.toLowerCase();
  let doc = await Category.findOne({ nameKey });
  if (doc) rep.cat.existing += 1;
  else {
    rep.cat.created += 1;
    if (APPLY) doc = await Category.create({ name, nameKey, order: toInt(c.sortOrder) || 0, active: c.status !== 'inactive' });
  }
  catMap.set(String(c._id), { id: doc?._id ?? `dry:${c._id}`, name });
}

/* ---- Produk (+ deskripsi + gambar) ---- */
const prodMap = new Map(); const prodByName = new Map();
const oldProducts = await read('products', { sortOrder: 1, _id: 1 });
let pi = 0;
for (const p of oldProducts) {
  pi += 1;
  const name = cleanName(p.name, 120);
  const cat = catMap.get(String(p.categoryId));
  const price = toInt(p.price); const stock = toInt(p.stock); const sold = toInt(p.sold);
  if (name.length < 2) { rep.prod.skipped.push(`"${p.name}" (nama kurang dari 2 karakter)`); continue; }
  if (!cat) { rep.prod.skipped.push(`"${name}" (kategori tidak ditemukan/dilewati)`); continue; }
  if (![price, stock, sold].every(Number.isFinite)) { rep.prod.skipped.push(`"${name}" (harga/stok/terjual tidak valid)`); continue; }
  const active = p.status !== 'inactive';
  const about = cleanText(p.description, 4000);
  if (String(p.description ?? '').trim().length > 4000) rep.prod.textTrimmed += 1;
  const blurb = makeBlurb(p.shortDescription, p.description, 300);
  if (about || blurb) rep.prod.withText += 1;

  let doc = await Product.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i') });
  if (doc) {
    rep.prod.updated += 1;
    if (APPLY) {
      doc.set({ price, stock, sold, active, category: cat.id });
      if (!doc.description && blurb) doc.description = blurb;   // teks yang sudah diisi di project baru tidak ditimpa
      if (!doc.about && about) doc.about = about;
    }
  } else {
    rep.prod.created += 1;
    if (APPLY) doc = await Product.create({ productId: await nextSeq('product'), name, category: cat.id, price, stock, sold, active, description: blurb, about });
  }

  // Gambar: utama + tambahan dari produk lama
  let coverKey = '';
  if (source) {
    const refs = legacyImageRefs(p);
    rep.img.refs += refs.length;
    if (!refs.length) rep.img.noImage += 1;
    else {
      if (pi % 5 === 1 || VERBOSE) console.log(`  … produk ${pi}/${oldProducts.length}: ${name} (${refs.length} gambar)`);
      const res = await migrateProductImages({ refs, ownerId: doc?._id, apply: APPLY }, imgDeps);
      rep.img.found += res.found; rep.img.copied += res.copied; rep.img.reused += res.reused;
      res.failed.forEach((f) => rep.img.failed.push(`${name} → ${f.label} (${f.reason})`));
      if (APPLY && doc && res.items.length) {
        const cur = doc.media || [];
        if (cur.every((m) => isLegacyKey(m.key))) {   // belum ada gambar, atau semuanya hasil migrasi: aman diatur ulang
          const keep = cur.filter((m) => !res.items.some((i) => i.key === m.key)).map((m) => ({ type: m.type, key: m.key, url: m.url }));
          doc.media = [...res.items, ...keep];
        } else rep.img.keptExisting += 1;   // admin sudah mengatur gambar sendiri di project baru: tidak diganggu
      }
    }
  }
  if (APPLY && doc) { await doc.save(); coverKey = (doc.media || []).find((m) => m.type === 'image')?.key || ''; }

  const entry = { ref: doc?._id ?? `dry:${p._id}`, productId: doc?.productId ?? 0, name: doc?.name ?? name, category: cat.name, sold, imported: 0, coverKey };
  prodMap.set(String(p._id), entry); prodByName.set(name.toLowerCase(), entry);
  if (VERBOSE) console.log(`  produk ${doc ? 'ok' : 'baru'}: ${name} · harga ${price} · stok ${stock} · terjual ${sold}`);
}

/* ---- Pesanan sukses + pembeli ---- */
if (!flags.has('skip-orders')) {
  const tx = new Map((await read('transactions')).map((t) => [String(t.orderId), t]));
  for (const o of await read('orders', { createdAt: 1 })) {
    const code = String(o.orderCode || '').trim();
    rep.ord.total += 1;
    if (!code) { rep.ord.skipped.push('(pesanan tanpa kode)'); continue; }
    const t = tx.get(String(o._id));
    const label = legacyStatusLabel(o, t); const status = mapOrderStatus(o, t);
    const take = ALL_ORDERS || status === 'SUCCESS';
    (rep.ord.legacy[label] ||= { n: 0, to: take ? status : 'dilewati (bukan sukses)' }).n += 1;
    if (!take) { rep.ord.notSuccess += 1; continue; }

    const entry = prodMap.get(String(o.product?.productId)) || prodByName.get(cleanName(o.product?.name, 120).toLowerCase());
    const already = await Order.findOne({ orderNo: code }).select('status payment.source payment.paidAt product.imageKey');
    if (already) {
      rep.ord.existing += 1;
      if (already.payment?.source === 'import') {
        // Pesanan hasil impor sebelumnya: perbaiki status yang salah baca & lengkapi gambar produk bila sudah ada
        const $set = {};
        if (already.status !== status) {
          rep.ord.repaired += 1; rep.ord.byStatus[status] = (rep.ord.byStatus[status] || 0) + 1;
          $set.status = status;
          if (status === 'SUCCESS') $set['payment.paidAt'] = t?.paidAt ? new Date(t.paidAt) : (o.updatedAt ? new Date(o.updatedAt) : new Date());
        }
        if (!already.product?.imageKey && entry?.coverKey) $set['product.imageKey'] = entry.coverKey;
        if (APPLY && Object.keys($set).length) await Order.collection.updateOne({ _id: already._id }, { $set });
        if (status === 'SUCCESS' && entry) entry.imported += 1;
      }
      continue;
    }
    const email = String(o.customer?.email || '').trim().toLowerCase().slice(0, 120);
    const total = toInt(o.total ?? (Number(o.product?.price) * Number(o.quantity || 1)), 1);
    // Produk sudah dihapus di sistem lama: pesanan TETAP diimpor memakai snapshot nama/kategori di pesanan itu.
    const snapName = cleanName(o.product?.name, 120) || entry?.name || '';
    if (!snapName) { rep.ord.skipped.push(`${code} (nama produk kosong)`); continue; }
    if (!email || !Number.isFinite(total)) { rep.ord.skipped.push(`${code} (email/nominal tidak valid)`); continue; }
    if (!entry) rep.ord.noProduct += 1;
    const wa = normalizeWa(o.customer?.whatsapp, normalizeWhatsapp);
    const createdAt = o.createdAt ? new Date(o.createdAt) : new Date(); const updatedAt = o.updatedAt ? new Date(o.updatedAt) : createdAt;
    const totalAmount = Number.isFinite(Number(t?.totalAmount)) ? Number(t.totalAmount) : null;
    const doc = {
      orderNo: code, status, rev: 1,
      customer: { name: cleanName(o.customer?.name, 60) || 'Pelanggan', email, whatsapp: wa.slice(0, 20) },
      product: { ref: entry?.ref ?? null, productId: entry?.productId ?? null, name: snapName, category: cleanName(o.product?.category, 60) || entry?.category || '', imageKey: entry?.coverKey || '' },
      amount: total, totalAmount, uniqueAmount: totalAmount && totalAmount >= total ? totalAmount - total : 0,
      expiresAt: t?.expiredAt ? new Date(t.expiredAt) : null,
      payment: { provider: 'klikqris', mode: t?.environment === 'sandbox' ? 'sandbox' : 'production', gatewayStatus: String(t?.status || ''), qrisUrl: '', source: 'import', ...(status === 'SUCCESS' ? { paidAt: t?.paidAt ? new Date(t.paidAt) : updatedAt } : {}) },
      origin: '', events: [{ at: createdAt, type: 'imported', detail: `dari project lama${Number(o.quantity) > 1 ? ` · jumlah ${o.quantity}` : ''}`.slice(0, 300) }],
      createdAt, updatedAt,
    };
    rep.ord.created += 1; rep.ord.buyers.add(`${email}|${wa}`); rep.ord.byStatus[status] = (rep.ord.byStatus[status] || 0) + 1;
    if (status === 'SUCCESS' && entry) entry.imported += 1;
    if (APPLY) await Order.create([doc], { timestamps: false });   // insert langsung: tanpa stok, tanpa notifikasi
  }

  /* ---- Terjual per produk: samakan dengan angka project lama ---- */
  // Project baru: Terjual = jumlah pesanan SUCCESS produk + soldAdjust. Di project lama sold naik sebesar quantity pesanan,
  // jadi soldAdjust = terjual lama − jumlah pesanan sukses yang diimpor untuk produk itu.
  for (const e of prodMap.values()) {
    const adjust = e.sold - e.imported;
    rep.sold.push({ name: e.name, old: e.sold, imported: e.imported, adjust });
    if (APPLY && e.ref) await Product.updateOne({ _id: e.ref }, { $set: { soldAdjust: adjust } });
  }
}

/* ---- Rating ---- */
if (!flags.has('skip-reviews')) {
  for (const r of await read('ratings', { createdAt: 1 })) {
    const legacyId = String(r._id);
    if (await Review.exists({ legacyId })) { rep.rev.existing += 1; continue; }
    const entry = r.productId ? prodMap.get(String(r.productId)) : null;
    const stars = toInt(r.rating, 1); const text = cleanName(r.review, 1000);
    if (r.productId && !entry) { rep.rev.skipped.push(`"${cleanName(r.user, 30)}" (produknya tidak ditemukan)`); continue; }
    if (!Number.isFinite(stars) || stars > 5 || !text) { rep.rev.skipped.push(`"${cleanName(r.user, 30)}" (bintang/ulasan tidak valid)`); continue; }
    const createdAt = r.createdAt ? new Date(r.createdAt) : new Date();
    rep.rev.created += 1;
    if (APPLY) await Review.create([{ product: entry?.ref ?? null, productId: entry?.productId ?? null, name: cleanName(r.user, 60) || 'Pengguna', stars, text, date: createdAt, status: mapReviewStatus(r.status), legacyId, createdAt, updatedAt: r.updatedAt ? new Date(r.updatedAt) : createdAt }], { timestamps: false });
  }
}

/* ---- Laporan ---- */
const oldCustomers = await old.db.collection('customers').countDocuments({});
console.log(); line('='); console.log(APPLY ? 'MIGRASI SELESAI (data ditulis)' : 'DRY-RUN MIGRASI (belum ada yang ditulis)'); line('=');
rowOut('MongoDB lama', `${hostOf(oldUri)} / ${oldDbName}`); rowOut('MongoDB baru', `${hostOf(config.mongoUri)} / ${mongoose.connection.name}`);
rowOut('Sumber gambar', SKIP_IMAGES ? '(dilewati: --skip-images)' : source.describe());
rowOut('Isi database lama', `${oldCount.categories} kategori · ${oldCount.products} produk · ${oldCount.orders} pesanan · ${oldCount.ratings} rating`); line();
rowOut('Kategori baru / sudah ada', `${rep.cat.created} / ${rep.cat.existing}`);
rowOut('Produk baru / diperbarui', `${rep.prod.created} / ${rep.prod.updated}`);
rowOut('  produk dengan deskripsi dari lama', rep.prod.withText);
if (rep.prod.textTrimmed) rowOut('  deskripsi dipotong (>4000 karakter)', rep.prod.textTrimmed);
if (!SKIP_IMAGES) {
  rowOut('Gambar produk di database lama', `${rep.img.refs}  (produk tanpa gambar: ${rep.img.noImage})`);
  rowOut(APPLY ? '  ditemukan & dimigrasi' : '  ditemukan di R2 lama', rep.img.found);
  if (APPLY) { rowOut('    disalin ke R2 baru', rep.img.copied); rowOut('    sudah ada (dipakai ulang)', rep.img.reused); }
  rowOut('  gagal / tidak ditemukan', rep.img.failed.length);
  if (rep.img.keptExisting) rowOut('  produk dengan gambar sendiri (tidak diubah)', rep.img.keptExisting);
}
if (!flags.has('skip-orders')) {
  rowOut('Pesanan di database lama', rep.ord.total);
  rowOut(ALL_ORDERS ? 'Pesanan diimpor / sudah ada' : 'Pesanan SUKSES diimpor / sudah ada', `${rep.ord.created} / ${rep.ord.existing}`);
  if (!ALL_ORDERS) rowOut('  pesanan tidak sukses (dilewati)', rep.ord.notSuccess);
  rowOut('  di antaranya produknya sudah dihapus', rep.ord.noProduct);
  rowOut('Pesanan lama yang diperbaiki statusnya', rep.ord.repaired);
  rowOut('Status lama (order/pembayaran/transaksi)', '');
  for (const [k, v] of Object.entries(rep.ord.legacy)) rowOut(`  ${k}`, `${v.n} → ${v.to}`);
  rowOut('Pembeli unik (dari pesanan)', `${rep.ord.buyers.size}  (tabel pelanggan lama: ${oldCustomers})`);
  const totOld = rep.sold.reduce((n, s) => n + s.old, 0); const totImp = rep.sold.reduce((n, s) => n + s.imported, 0);
  rowOut('Terjual (jumlah semua produk, lama)', totOld);
  rowOut('  pesanan sukses yang diimpor untuk produk', totImp);
  rowOut('  selisih dijaga lewat soldAdjust', `${totOld - totImp}  → Marketplace tetap menampilkan ${totOld}`);
  const diff = rep.sold.filter((s) => s.adjust !== 0);
  if (VERBOSE || diff.length) {
    console.log(`\nTerjual per produk${VERBOSE ? '' : ' (hanya yang ada selisih)'}: lama · pesanan sukses diimpor · penyesuaian`);
    (VERBOSE ? rep.sold : diff).slice(0, VERBOSE ? undefined : 15).forEach((s) => console.log(`  - ${s.name}: ${s.old} · ${s.imported} · ${s.adjust >= 0 ? '+' : ''}${s.adjust}`));
    if (!VERBOSE && diff.length > 15) console.log(`  … dan ${diff.length - 15} lainnya (--verbose untuk semua)`);
  }
} else if (APPLY) console.log('\n(--skip-orders: angka Terjual tidak disesuaikan; tampil sesuai jumlah pesanan sukses yang ada.)');
if (!flags.has('skip-reviews')) rowOut('Rating diimpor / sudah ada', `${rep.rev.created} / ${rep.rev.existing}`);
for (const [label, list] of [['Kategori', rep.cat.skipped], ['Produk', rep.prod.skipped], ['Gambar', rep.img.failed], ['Pesanan', rep.ord.skipped], ['Rating', rep.rev.skipped]]) {
  if (!list.length) continue;
  console.log(`\n${label} ${label === 'Gambar' ? 'gagal/tidak ditemukan' : 'dilewati'} (${list.length}):`);
  list.slice(0, 15).forEach((x) => console.log(`  - ${x}`));
  if (list.length > 15) console.log(`  … dan ${list.length - 15} lainnya`);
}
line();
if (!APPLY) console.log('Ini hanya laporan. Jalankan lagi dengan --apply untuk menulis.');
else console.log('Selesai. Restart server agar tampilan Marketplace/Admin langsung memuat data baru.');
await bye(0);
