import { waitingOrders } from './codes.js';
import { ensureOrderCode } from './payments.js';

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
