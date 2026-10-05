import { Router } from 'express';
import { asyncH } from '../lib/http.js';
import { NotificationLog } from '../models/index.js';
import { verifySvixSignature } from '../lib/svix.js';
import { getResendWebhookSecret } from '../services/integrationSettings.js';
import { emitAdmin } from '../lib/realtime.js';
import { logView } from '../services/notifications.js';
import { webhookLimiter } from '../middleware/security.js';

/**
 * Webhook Resend: melaporkan apa yang SEBENARNYA terjadi setelah email diterima antrean (delivered / bounced / complained /
 * delayed). Status "sent" di NotificationLog hanya berarti Resend menerima permintaan; deliveryStatus di sini membuktikan
 * hasilnya. Keaslian diverifikasi lewat signature Svix atas byte mentah body. Mengikuti webhook.controller.js project lama.
 */
const EVENT_MAP = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.delivery_delayed': 'delayed',
};
const router = Router();

router.post('/resend', webhookLimiter, asyncH(async (req, res) => {
  const secret = await getResendWebhookSecret();
  if (!secret) return res.status(200).json({ ok: true, ignored: true });   // belum diatur: jangan proses payload yang tak bisa diverifikasi
  const valid = verifySvixSignature({
    secret, id: req.headers['svix-id'], timestamp: req.headers['svix-timestamp'], signatureHeader: req.headers['svix-signature'], rawBody: req.rawBody,
  });
  if (!valid) { console.warn('[Webhook][resend] signature tidak valid — kemungkinan webhook palsu'); return res.status(401).json({ ok: false, error: 'signature tidak valid' }); }

  const deliveryStatus = EVENT_MAP[req.body?.type];
  const messageId = req.body?.data?.email_id;
  if (!deliveryStatus || !messageId) return res.status(200).json({ ok: true, ignored: true });

  const log = await NotificationLog.findOneAndUpdate({ resendMessageId: messageId }, { $set: { deliveryStatus, deliveryStatusAt: new Date() } }, { new: true });
  if (!log) return res.status(200).json({ ok: true, ignored: true });
  emitAdmin('notification:log', logView(log));
  res.status(200).json({ ok: true });
}));

export default router;
