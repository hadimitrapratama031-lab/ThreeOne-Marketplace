import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { safeEqual } from './secrets.js';

/** Token akses pelanggan diturunkan dari APP_SECRET + conversationId (pola sama dengan orderToken): tidak disimpan, tidak bisa ditebak. */
export const livechatTokenFor = (conversationId) => crypto.createHmac('sha256', config.appSecret).update(`livechat-token:${conversationId}`).digest('hex').slice(0, 40);
export const livechatTokenOk = (conversationId, token) => typeof token === 'string' && token.length > 0 && safeEqual(token, livechatTokenFor(conversationId));

// ID publik percakapan: LC- + 10 karakter tanpa huruf membingungkan (0/O, 1/I). ID bukan rahasia; aksesnya dijaga token di atas.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newConversationId() {
  const b = crypto.randomBytes(10);
  let out = 'LC-';
  for (const x of b) out += ALPHABET[x % ALPHABET.length];
  return out;
}
export const CONVERSATION_ID_RE = /^LC-[A-Z0-9]{10}$/;
