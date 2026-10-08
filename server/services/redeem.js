import { RedeemCode, Order } from '../models/index.js';
import { HttpError } from '../lib/http.js';
import { emitAdmin } from '../lib/realtime.js';
import { parseCodeLines, maskCode } from '../lib/codes.js';
import { waitingOrders, admCode, syncProductStock, scheduleStats, broadcastProduct } from './codes.js';
import { ensureOrderCode, emitOrder } from './payments.js';

/**
 * Pemenuhan antrean: setelah Admin menambah stok, pesanan yang sudah dibayar tapi menunggu code diberi code,
 * yang paling lama dulu. Berhenti begitu stok habis lagi; sisanya tetap menunggu.
 * (Dipisah dari codes.js agar tidak saling impor dengan payments.js.)
 */
export async function fulfillWaitingOrders(productRef) {
  let fulfilled = 0;
  for (const o of await waitingOrders(productRef, 200)) {
    const after = await ensureOrderCode(o);
    if (after.codeState === 'assigned') fulfilled += 1;
    else break;
  }
  return fulfilled;
}

/* ------------------------------------------------------------------ Edit / Hapus satu code (Laporan Code)
 * Memakai koleksi RedeemCode dan alur pemberian code yang sudah ada; tidak ada sistem baru.
 *  - Semua perubahan atomik per dokumen: filter menyertakan status (dan order) yang dibaca sebelumnya, jadi bila webhook / pemberian
 *    code berjalan bersamaan dan status code berubah, perubahan Admin ditolak (409) alih-alih menimpa data yang baru.
 *  - Code yang sudah diberikan (sold) hanya berubah bila Admin mengirim `confirm` (peringatan ditampilkan di UI, dicek ulang di sini).
 *  - Order & Payment TIDAK dihapus. Isi code tidak pernah masuk log server maupun order.events.
 */
const dupError = () => new HttpError(409, 'Code ini sudah ada di sistem.', { fields: { code: 'Code ini sudah dipakai code lain' } });
const changedError = () => new HttpError(409, 'Code ini baru saja berubah (sudah diberikan ke pelanggan atau dihapus). Muat ulang daftar lalu coba lagi.');
const needConfirm = (cur, what) => new HttpError(409, `Code ini sudah diberikan ke pelanggan. Konfirmasi diperlukan sebelum ${what}.`, { requiresConfirm: true, orderNo: cur.orderNo || '' });

/** Naikkan rev order (supaya halaman pelanggan menerima pembaruan), catat kejadian tanpa isi code, lalu siarkan. Gagal di sini tidak membatalkan perubahan code. */
async function touchOrder(orderId, type, detail, set = {}) {
  try {
    const o = await Order.findOneAndUpdate(
      { _id: orderId, status: 'SUCCESS' },
      { $set: set, $inc: { rev: 1 }, $push: { events: { $each: [{ at: new Date(), type, detail: String(detail).slice(0, 300) }], $slice: -30 } } },
      { new: true },
    );
    if (!o) return null;
    await emitOrder(o);
    return o;
  } catch (err) {
    console.error(`[code] gagal memperbarui order terkait: ${err.message}`);
    return null;
  }
}

export async function editCode(id, { code: raw, confirm = false }) {
  const parsed = parseCodeLines([String(raw ?? '')]);
  if (parsed.invalid.length) throw new HttpError(422, 'Code tidak valid.', { fields: { code: `Code ${parsed.invalid[0].reason}` } });
  if (!parsed.codes.length) throw new HttpError(422, 'Code tidak boleh kosong.', { fields: { code: 'Masukkan code' } });
  const { code, codeKey } = parsed.codes[0];

  const cur = await RedeemCode.findById(id);
  if (!cur) throw new HttpError(404, 'Code tidak ditemukan.');
  if (cur.code === code) return { item: await RedeemCode.findById(id).populate('product', 'name'), changed: false };
  if (cur.status === 'sold' && !confirm) throw needConfirm(cur, 'mengubahnya');
  if (codeKey !== cur.codeKey && await RedeemCode.exists({ codeKey, _id: { $ne: cur._id } })) throw dupError();

  let updated;
  try {
    updated = await RedeemCode.findOneAndUpdate(
      { _id: cur._id, status: cur.status, codeKey: cur.codeKey, order: cur.order ?? null },
      { $set: { code, codeKey } },
      { new: true, runValidators: true },
    ).populate('product', 'name');
  } catch (err) {
    if (err?.code === 11000) throw dupError();   // balapan dengan penambahan code yang sama
    throw err;
  }
  if (!updated) throw changedError();

  console.log(`[code] code ${maskCode(cur.code)} -> ${maskCode(code)} diubah Admin (${cur.status}${cur.orderNo ? `, order ${cur.orderNo}` : ''})`);
  emitAdmin('code:update', admCode(updated));   // available tetap disamarkan; sold tampil utuh
  scheduleStats();
  if (updated.order) await touchOrder(updated.order, 'code_edited', 'code diubah Admin');   // halaman pesanan pelanggan menampilkan code terbaru
  return { item: updated, changed: true };
}

export async function removeCode(id, { confirm = false } = {}) {
  const cur = await RedeemCode.findById(id);
  if (!cur) throw new HttpError(404, 'Code tidak ditemukan.');
  if (cur.status === 'sold' && !confirm) throw needConfirm(cur, 'menghapusnya');

  const gone = await RedeemCode.findOneAndDelete({ _id: cur._id, status: cur.status, order: cur.order ?? null });
  if (!gone) {
    if (!(await RedeemCode.exists({ _id: cur._id }))) throw new HttpError(404, 'Code tidak ditemukan.');   // sudah dihapus Admin lain
    throw changedError();
  }

  console.log(`[code] code ${maskCode(cur.code)} dihapus Admin (${cur.status}${cur.orderNo ? `, order ${cur.orderNo}` : ''})`);
  let replaced = false;
  if (cur.status === 'sold' && cur.order) {
    // Order tetap ada. Ia kembali ke antrean "menunggu code" yang sudah ada: bila stok tersedia langsung mendapat code pengganti,
    // bila tidak, dipenuhi otomatis saat stok ditambah (alur yang sama dengan pesanan yang dibayar saat stok habis).
    const o = await touchOrder(cur.order, 'code_removed', 'code dihapus Admin; menunggu code pengganti', { codeState: 'waiting' });
    if (o) replaced = (await ensureOrderCode(o)).codeState === 'assigned';
  }
  await syncProductStock(cur.product);
  await broadcastProduct(cur.product);   // stok di Marketplace
  emitAdmin('code:delete', { id: String(cur._id), productId: cur.productId });
  scheduleStats();
  return { id: String(cur._id), status: cur.status, orderNo: cur.orderNo || '', replaced };
}
