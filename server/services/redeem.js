import { Order } from '../models/index.js';
import { markRedeemed, waitingOrders } from './codes.js';
import { emitOrder, ensureOrderCode } from './payments.js';

/**
 * Lapisan di atas services/codes.js yang butuh alur payment (menyiarkan order ke halaman pelanggan).
 * Dipisah agar codes.js tidak saling impor dengan payments.js.
 */

/** Tandai Redeemed (atomic) lalu perbarui halaman Payment pelanggan lewat Socket.IO yang sudah ada. */
export async function redeemCode(by, source) {
  const doc = await markRedeemed(by, source);
  if (doc.order) {
    const o = await Order.findOneAndUpdate(
      { _id: doc.order },
      { $inc: { rev: 1 }, $push: { events: { $each: [{ at: new Date(), type: 'code_redeemed', detail: source }], $slice: -30 } } },
      { new: true },
    );
    if (o) await emitOrder(o);
  }
  return doc;
}

/**
 * Setelah Admin menambah stok: pesanan yang sudah dibayar tapi menunggu code diberi code, yang paling lama dulu.
 * Berhenti begitu stok habis lagi; sisanya tetap menunggu.
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
