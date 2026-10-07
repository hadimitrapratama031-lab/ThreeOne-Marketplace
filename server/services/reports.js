import { Order, ReportReset } from '../models/index.js';
import { HttpError, pageMeta } from '../lib/http.js';
import { emitAdmin } from '../lib/realtime.js';

/**
 * Laporan "Keuntungan Per Bulan". SUMBER KEBENARAN TUNGGAL = koleksi Order (tidak ada koleksi rekap berisi angka).
 *
 * Yang dihitung (dipaksa di query MongoDB, bukan di frontend):
 *   - status === 'SUCCESS'            : pembayaran berhasil. PENDING / EXPIRED / FAILED tidak pernah masuk.
 *                                       Order yang dibayar terlambat juga SUCCESS lewat markPaid() (latePayment), dananya memang masuk.
 *   - payment.mode === 'production'   : snapshot mode saat checkout. Sandbox TIDAK dihitung walau SUCCESS.
 *
 * Tidak ada penghitungan ganda: satu order = satu dokumen (orderNo unik), dan markPaid() hanya memenangkan transisi SUCCESS satu kali,
 * jadi webhook ganda / polling / reconnect tidak menambah baris. Laporan hanya MEMBACA, jadi muat-ulang berapa kali pun hasilnya sama.
 *
 * Nominal = uang yang benar-benar dibayar: `totalAmount` (dari KlikQRIS, sudah memuat kode unik) bila ada, selain itu `amount` (harga produk).
 * Waktu = `payment.paidAt` (kapan dibayar), cadangan `createdAt` bila kosong. Bulan dikelompokkan menurut WIB (Asia/Jakarta).
 * Satu order = satu produk terjual (sama seperti `quantity: 1` di Cek Pesanan dan definisi "Terjual" di services/sales.js).
 * Product tidak punya modal/HPP, jadi laporan ini hanya memuat pendapatan; tidak ada angka keuntungan yang dikarang.
 */
const TZ = 'Asia/Jakarta';
const PAID_AT = { $ifNull: ['$payment.paidAt', '$createdAt'] };
const PAID_AMOUNT = { $ifNull: ['$totalAmount', '$amount'] };

/* ---------- Tanggal (WIB tidak mengenal DST, jadi offset tetap +07:00 selalu benar) ---------- */
const pad = (n) => String(n).padStart(2, '0');
const dayStart = (ymd) => new Date(`${ymd}T00:00:00+07:00`);
const monthStart = (y, m) => dayStart(`${y}-${pad(m)}-01`);
const ymOf = (d) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 7);
function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  return { gte: monthStart(y, m), lt: m === 12 ? monthStart(y + 1, 1) : monthStart(y, m + 1) };
}
function prevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

/** Rentang waktu bayar dari filter tanggal: rentang custom menang atas tahun/bulan. Batas atas eksklusif. {} = semua waktu. */
function resolveRange(f) {
  if (f.from || f.to) {
    return {
      gte: f.from ? dayStart(f.from) : undefined,
      lt: f.to ? new Date(dayStart(f.to).getTime() + 86_400_000) : undefined,
    };
  }
  if (f.year && f.month) return monthBounds(`${f.year}-${pad(f.month)}`);
  if (f.year) return { gte: monthStart(f.year, 1), lt: monthStart(f.year + 1, 1) };
  return {};
}

/* ---------- Pipeline ---------- */
function baseMatch(f) {
  const m = { status: 'SUCCESS', 'payment.mode': 'production' };
  if (f.payment === 'late') m.latePayment = true;
  else if (f.payment === 'ontime') m.latePayment = { $ne: true };
  if (f.productId) m['product.productId'] = f.productId;
  if (f.category) m['product.category'] = f.category;
  return m;
}

/** Tiga tahap sama untuk SEMUA angka (ringkasan, daftar bulan, detail, dampak hapus) supaya angkanya selalu cocok satu sama lain. */
function matchStages(f, range, resets, cutoff) {
  const paidAt = {};
  if (range.gte) paidAt.$gte = range.gte;
  if (range.lt) paidAt.$lt = range.lt;
  if (cutoff) paidAt.$lte = cutoff;
  const after = {};
  if (Object.keys(paidAt).length) after.paidAt = paidAt;
  if (resets.length) {
    after.$nor = resets.map((r) => {
      const b = monthBounds(r.month);
      return { paidAt: { $gte: b.gte, $lt: b.lt, $lte: r.cutoff } };
    });
  }
  return [{ $match: baseMatch(f) }, { $addFields: { paidAt: PAID_AT } }, { $match: after }];
}

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const row = (month, orders, revenue) => ({
  month,
  orders,
  items: orders,
  revenue: money(revenue),
  average: orders ? money(revenue / orders) : 0,
});
const loadResets = () => ReportReset.find().select('month cutoff').lean();

async function groupByMonth(f, range, resets) {
  const rows = await Order.aggregate([
    ...matchStages(f, range, resets),
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m', date: '$paidAt', timezone: TZ } },
        orders: { $sum: 1 },
        revenue: { $sum: PAID_AMOUNT },
      },
    },
    { $sort: { _id: -1 } },
  ]);
  return rows.map((r) => row(r._id, r.orders, r.revenue));
}

/** Pilihan filter diambil dari transaksi production yang benar-benar ada (bukan dari daftar produk), tanpa terpengaruh filter aktif. */
async function filterOptions(resets) {
  const [res] = await Order.aggregate([
    ...matchStages({}, {}, resets),
    {
      $facet: {
        years: [{ $group: { _id: { $dateToString: { format: '%Y', date: '$paidAt', timezone: TZ } } } }],
        products: [
          { $match: { 'product.productId': { $ne: null } } },
          { $sort: { paidAt: 1 } },
          { $group: { _id: '$product.productId', name: { $last: '$product.name' } } },
        ],
        categories: [
          { $match: { 'product.category': { $nin: [null, ''] } } },
          { $group: { _id: '$product.category' } },
        ],
      },
    },
  ]);
  return {
    years: res.years.map((y) => Number(y._id)).sort((a, b) => b - a),
    products: res.products.map((p) => ({ productId: p._id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name, 'id')),
    categories: res.categories.map((c) => c._id).sort((a, b) => a.localeCompare(b, 'id')),
  };
}

const change = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

/** Bulan berjalan (WIB) dan bulan sebelumnya. Mengikuti filter produk/kategori/status bayar, bukan filter tanggal. */
async function currentSummary(f, resets) {
  const month = ymOf(new Date());
  const previous = prevMonth(month);
  const rows = await groupByMonth(f, { gte: monthBounds(previous).gte, lt: monthBounds(month).lt }, resets);
  const cur = rows.find((r) => r.month === month) ?? row(month, 0, 0);
  const prev = rows.find((r) => r.month === previous) ?? row(previous, 0, 0);
  return {
    current: cur,
    previous: prev,
    comparable: prev.orders > 0,   // tanpa transaksi di bulan sebelumnya tidak ada pembanding yang jujur
    change: { revenue: change(cur.revenue, prev.revenue), orders: change(cur.orders, prev.orders) },
  };
}

/* ---------- API ---------- */
export async function monthlyReport(f) {
  const resets = await loadResets();
  const [months, summary, options] = await Promise.all([
    groupByMonth(f, resolveRange(f), resets),
    currentSummary(f, resets),
    filterOptions(resets),
  ]);
  const orders = months.reduce((n, m) => n + m.orders, 0);
  const revenue = months.reduce((n, m) => n + m.revenue, 0);
  return { generatedAt: new Date().toISOString(), summary, totals: row('total', orders, revenue), months, options };
}

/** Transaksi pembentuk satu bulan. Memakai filter yang sama dengan daftar bulan, jadi `totals` selalu sama dengan baris bulan tersebut. */
export async function monthDetail(f, ym, { page, limit }) {
  const resets = await loadResets();
  const mb = monthBounds(ym);
  const fr = resolveRange(f);
  const range = { gte: fr.gte && fr.gte > mb.gte ? fr.gte : mb.gte, lt: fr.lt && fr.lt < mb.lt ? fr.lt : mb.lt };
  const [res] = await Order.aggregate([
    ...matchStages(f, range, resets),
    {
      $facet: {
        totals: [{ $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: PAID_AMOUNT } } }],
        items: [
          { $sort: { paidAt: -1, _id: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            // daftar putih: signature & data gateway tidak ikut keluar
            $project: {
              orderNo: 1, paidAt: 1, amount: 1, latePayment: 1,
              paid: PAID_AMOUNT,
              'customer.name': 1, 'customer.email': 1, 'customer.whatsapp': 1,
              'product.productId': 1, 'product.name': 1, 'product.category': 1,
              'payment.mode': 1,
            },
          },
        ],
      },
    },
  ]);
  const t = res.totals[0] ?? { orders: 0, revenue: 0 };
  return {
    totals: row(ym, t.orders, t.revenue),
    items: res.items.map((o) => ({
      id: String(o._id),
      orderNo: o.orderNo,
      paidAt: o.paidAt.toISOString(),
      customer: o.customer,
      product: { id: o.product.productId, name: o.product.name, category: o.product.category || '' },
      quantity: 1,
      price: o.amount,
      uniqueAmount: money(o.paid - o.amount),   // kode unik KlikQRIS: selisih nominal bayar dan harga produk
      total: money(o.paid),
      status: 'SUCCESS',
      late: Boolean(o.latePayment),
      mode: o.payment?.mode || 'production',
    })),
    ...pageMeta(page, limit, t.orders),
  };
}

/* ---------- Hapus rekap bulan ---------- */
/** Apa yang akan hilang dari rekap bulan ini (tanpa filter). `asOf` = batas waktu yang dilihat admin, dikembalikan agar hapus memakai batas yang sama. */
export async function monthImpact(ym, asOf = new Date()) {
  const resets = await loadResets();
  const [t] = await Order.aggregate([
    ...matchStages({}, monthBounds(ym), resets, asOf),
    { $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: PAID_AMOUNT } } },
  ]);
  return { month: ym, orders: t?.orders ?? 0, revenue: money(t?.revenue), asOf: asOf.toISOString() };
}

/**
 * Hapus rekap = sembunyikan order production bulan itu yang dibayar sampai `asOf` dari laporan ini. Order/Payment tidak dihapus atau diubah
 * (Dashboard, Pesanan, "Terjual" produk tetap sama). Pembayaran yang masuk setelah `asOf` tetap terhitung, jadi yang terhapus persis
 * sama dengan yang ditampilkan di dialog konfirmasi.
 */
export async function clearMonth(ym, asOfRaw, adminId) {
  const asOf = new Date(asOfRaw);
  if (Number.isNaN(asOf.getTime()) || asOf.getTime() > Date.now() + 5000) {
    throw new HttpError(422, 'Waktu acuan tidak valid. Tutup dialog lalu buka lagi.');
  }
  const impact = await monthImpact(ym, asOf);
  if (!impact.orders) throw new HttpError(404, 'Tidak ada rekap yang bisa dihapus untuk bulan ini.');
  await ReportReset.updateOne(
    { month: ym },
    {
      $max: { cutoff: asOf },
      $set: { clearedAt: new Date(), clearedBy: adminId ?? null },
      $inc: { clearedOrders: impact.orders, clearedAmount: impact.revenue },
    },
    { upsert: true },
  );
  emitAdmin('report:update', { month: ym });   // Admin lain yang membuka halaman ini ikut menyegarkan
  return impact;
}
