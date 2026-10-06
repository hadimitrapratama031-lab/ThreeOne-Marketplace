/**
 * Migrasi data dari database project Marketplace LAMA ke project baru.
 *
 *   OLD_MONGODB_URI="mongodb+srv://…/NAMA_DB_LAMA" node scripts/migrate-from-old.js            → DRY-RUN (hanya laporan)
 *   OLD_MONGODB_URI="…" node scripts/migrate-from-old.js --apply                               → tulis ke database baru (MONGODB_URI di .env)
 *
 * Yang dimigrasi:
 *   • Kategori   : nama, urutan, aktif/nonaktif
 *   • Produk     : nama, harga, stok, JUMLAH TERJUAL, status aktif, kategori. Deskripsi, gambar, spesifikasi, dll. TIDAK diambil
 *                  dari lama. Produk baru dengan nama sama (tanpa peduli huruf) hanya DIPERBARUI harga/stok/terjual/status/kategori-nya.
 *   • Pesanan + pembeli : tiap pesanan lama jadi riwayat pesanan (nama, email, WhatsApp, produk, nominal, status, waktu, mode
 *                  sandbox/production dari transaksi). Project baru tidak punya tabel pelanggan terpisah: data pembeli tersimpan di pesanan.
 *                  Tidak mengubah stok, tidak mengirim notifikasi, tidak ada yang berstatus "menunggu".
 *   • Rating     : bintang, ulasan, nama, tanggal. approved→tayang; hidden/pending→tersembunyi. Tanpa produk (atau produknya sudah dihapus) = tetap diimpor sebagai ulasan umum.
 * Aman dijalankan berulang (tidak membuat data dobel). Opsi: --skip-orders --skip-reviews --verbose
 */
import mongoose from 'mongoose';
import { config } from '../server/config/env.js';
import { Product, Category, Review, Order, nextSeq } from '../server/models/index.js';
import { normalizeWhatsapp } from '../server/lib/phone.js';
import { parseArgs, line, rowOut, hostOf } from './_common.js';
import { escapeRegex, legacyStatusLabel, mapOrderStatus, mapReviewStatus, cleanName, toInt, normalizeWa, sameDb } from './legacyMap.js';

const { flags, values } = parseArgs();
const APPLY = flags.has('apply');
const VERBOSE = flags.has('verbose');
const oldUri = values['old-uri'] || process.env.OLD_MONGODB_URI;
if (!oldUri) { console.error('Isi OLD_MONGODB_URI (connection string database LAMA, lengkap dengan nama database).'); process.exit(1); }
const oldDbName = (String(oldUri).match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/) || [])[1] || '';
if (!oldDbName) { console.error('OLD_MONGODB_URI belum memuat NAMA DATABASE. Bentuknya: mongodb+srv://user:pass@host/NAMA_DB_LAMA?appName=… (nama ada setelah "/" dan sebelum "?"). Tanpa nama, MongoDB membaca database kosong bernama "test".'); process.exit(1); }
if (!config.mongoUri) { console.error('MONGODB_URI (database BARU) belum diisi di .env'); process.exit(1); }
if (sameDb(oldUri, config.mongoUri)) { console.error('OLD_MONGODB_URI sama dengan MONGODB_URI. Dibatalkan agar data tidak tertimpa.'); process.exit(1); }

await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10_000 });
const old = await mongoose.createConnection(oldUri, { serverSelectionTimeoutMS: 10_000 }).asPromise();
const read = (name, sort = { _id: 1 }) => old.db.collection(name).find({}).sort(sort).toArray();

const rep = { cat: { created: 0, existing: 0, skipped: [] }, prod: { created: 0, updated: 0, skipped: [] }, ord: { created: 0, existing: 0, repaired: 0, noProduct: 0, total: 0, skipped: [], buyers: new Set(), byStatus: {}, legacy: {} }, rev: { created: 0, existing: 0, skipped: [] } };

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

/* ---- Produk ---- */
const prodMap = new Map(); const prodByName = new Map();
for (const p of await read('products', { sortOrder: 1, _id: 1 })) {
  const name = cleanName(p.name, 120);
  const cat = catMap.get(String(p.categoryId));
  const price = toInt(p.price); const stock = toInt(p.stock); const sold = toInt(p.sold);
  if (name.length < 2) { rep.prod.skipped.push(`"${p.name}" (nama kurang dari 2 karakter)`); continue; }
  if (!cat) { rep.prod.skipped.push(`"${name}" (kategori tidak ditemukan/dilewati)`); continue; }
  if (![price, stock, sold].every(Number.isFinite)) { rep.prod.skipped.push(`"${name}" (harga/stok/terjual tidak valid)`); continue; }
  const active = p.status !== 'inactive';
  let doc = await Product.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i') });
  if (doc) {
    rep.prod.updated += 1;
    if (APPLY) { doc.set({ price, stock, sold, active, category: cat.id }); await doc.save(); }   // deskripsi, gambar, spesifikasi: tidak disentuh
  } else {
    rep.prod.created += 1;
    if (APPLY) doc = await Product.create({ productId: await nextSeq('product'), name, category: cat.id, price, stock, sold, active });
  }
  const entry = { ref: doc?._id ?? `dry:${p._id}`, productId: doc?.productId ?? 0, name: doc?.name ?? name, category: cat.name, sold };
  prodMap.set(String(p._id), entry); prodByName.set(name.toLowerCase(), entry);
  if (VERBOSE) console.log(`  produk ${doc ? 'ok' : 'baru'}: ${name} · harga ${price} · stok ${stock} · terjual ${sold}`);
}

/* ---- Pesanan + pembeli ---- */
if (!flags.has('skip-orders')) {
  const tx = new Map((await read('transactions')).map((t) => [String(t.orderId), t]));
  for (const o of await read('orders', { createdAt: 1 })) {
    const code = String(o.orderCode || '').trim();
    rep.ord.total += 1;
    if (!code) { rep.ord.skipped.push('(pesanan tanpa kode)'); continue; }
    const t0 = tx.get(String(o._id));
    const label = legacyStatusLabel(o, t0); const mapped = mapOrderStatus(o, t0);
    (rep.ord.legacy[label] ||= { n: 0, to: mapped }).n += 1;
    const already = await Order.findOne({ orderNo: code }).select('status payment.source payment.paidAt');
    if (already) {
      rep.ord.existing += 1;
      // Pesanan hasil impor sebelumnya yang statusnya salah baca (mis. selesai tapi tercatat EXPIRED) diperbaiki di sini
      if (already.payment?.source === 'import' && already.status !== mapped) {
        rep.ord.repaired += 1; rep.ord.byStatus[mapped] = (rep.ord.byStatus[mapped] || 0) + 1;
        if (APPLY) await Order.collection.updateOne({ _id: already._id }, { $set: { status: mapped, ...(mapped === 'SUCCESS' ? { 'payment.paidAt': t0?.paidAt ? new Date(t0.paidAt) : (o.updatedAt ? new Date(o.updatedAt) : new Date()) } : {}) } });
      }
      continue;
    }
    const entry = prodMap.get(String(o.product?.productId)) || prodByName.get(cleanName(o.product?.name, 120).toLowerCase());
    const email = String(o.customer?.email || '').trim().toLowerCase().slice(0, 120);
    const total = toInt(o.total ?? (Number(o.product?.price) * Number(o.quantity || 1)), 1);
    // Produk sudah dihapus di sistem lama: pesanan TETAP diimpor memakai snapshot nama/kategori di pesanan itu,
    // supaya jumlah pesanan selesai tidak berkurang (sebelumnya pesanan seperti ini dilewati).
    const snapName = cleanName(o.product?.name, 120) || entry?.name || '';
    if (!snapName) { rep.ord.skipped.push(`${code} (nama produk kosong)`); continue; }
    if (!email || !Number.isFinite(total)) { rep.ord.skipped.push(`${code} (email/nominal tidak valid)`); continue; }
    if (!entry) rep.ord.noProduct += 1;
    const t = tx.get(String(o._id));
    const status = mapped;
    const wa = normalizeWa(o.customer?.whatsapp, normalizeWhatsapp);
    const createdAt = o.createdAt ? new Date(o.createdAt) : new Date(); const updatedAt = o.updatedAt ? new Date(o.updatedAt) : createdAt;
    const totalAmount = Number.isFinite(Number(t?.totalAmount)) ? Number(t.totalAmount) : null;
    const doc = {
      orderNo: code, status, rev: 1,
      customer: { name: cleanName(o.customer?.name, 60) || 'Pelanggan', email, whatsapp: wa.slice(0, 20) },
      product: { ref: entry?.ref ?? null, productId: entry?.productId ?? null, name: snapName, category: cleanName(o.product?.category, 60) || entry?.category || '', imageKey: '' },
      amount: total, totalAmount, uniqueAmount: totalAmount && totalAmount >= total ? totalAmount - total : 0,
      expiresAt: t?.expiredAt ? new Date(t.expiredAt) : null,
      payment: { provider: 'klikqris', mode: t?.environment === 'sandbox' ? 'sandbox' : 'production', gatewayStatus: String(t?.status || ''), qrisUrl: '', source: 'import', ...(status === 'SUCCESS' ? { paidAt: t?.paidAt ? new Date(t.paidAt) : updatedAt } : {}) },
      origin: '', events: [{ at: createdAt, type: 'imported', detail: `dari project lama${Number(o.quantity) > 1 ? ` · jumlah ${o.quantity}` : ''}`.slice(0, 300) }],
      createdAt, updatedAt,
    };
    rep.ord.created += 1; rep.ord.buyers.add(`${email}|${wa}`); rep.ord.byStatus[status] = (rep.ord.byStatus[status] || 0) + 1;
    if (APPLY) await Order.create([doc], { timestamps: false });   // insert langsung: tanpa stok, tanpa notifikasi
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
line('='); console.log(APPLY ? 'MIGRASI SELESAI (data ditulis)' : 'DRY-RUN MIGRASI (belum ada yang ditulis)'); line('=');
rowOut('Database lama', `${hostOf(oldUri)} / ${oldDbName}`); rowOut('Database baru', `${hostOf(config.mongoUri)} / ${mongoose.connection.name}`); line();
rowOut('Kategori baru / sudah ada', `${rep.cat.created} / ${rep.cat.existing}`);
rowOut('Produk baru / diperbarui', `${rep.prod.created} / ${rep.prod.updated}`);
if (!flags.has('skip-orders')) {
  rowOut('Pesanan di database lama', rep.ord.total);
  rowOut('Pesanan diimpor / sudah ada', `${rep.ord.created} / ${rep.ord.existing}`);
  rowOut('  di antaranya produknya sudah dihapus', rep.ord.noProduct);
  rowOut('Pesanan lama yang diperbaiki statusnya', rep.ord.repaired);
  rowOut('Status lama (order/pembayaran/transaksi)', '');
  for (const [k, v] of Object.entries(rep.ord.legacy)) rowOut(`  ${k}`, `${v.n} → ${v.to}`);
  rowOut('Total terjual (dari produk lama)', [...prodMap.values()].reduce((n, p) => n + p.sold, 0));
  rowOut('  per status', Object.entries(rep.ord.byStatus).map(([k, v]) => `${k} ${v}`).join(' · ') || '-');
  rowOut('Pembeli unik (dari pesanan)', `${rep.ord.buyers.size}  (tabel pelanggan lama: ${oldCustomers})`);
}
if (!flags.has('skip-reviews')) rowOut('Rating diimpor / sudah ada', `${rep.rev.created} / ${rep.rev.existing}`);
for (const [label, list] of [['Kategori', rep.cat.skipped], ['Produk', rep.prod.skipped], ['Pesanan', rep.ord.skipped], ['Rating', rep.rev.skipped]]) {
  if (!list.length) continue;
  console.log(`\n${label} dilewati (${list.length}):`);
  list.slice(0, 15).forEach((x) => console.log(`  - ${x}`));
  if (list.length > 15) console.log(`  … dan ${list.length - 15} lainnya`);
}
line();
if (!APPLY) console.log('Ini hanya laporan. Jalankan lagi dengan --apply untuk menulis.');
else console.log('Selesai. Restart server agar tampilan Marketplace/Admin langsung memuat data baru.');
await old.close(); await mongoose.disconnect();
