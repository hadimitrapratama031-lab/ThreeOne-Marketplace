import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { safeEqual } from './secrets.js';

/** Token akses pelanggan diturunkan dari APP_SECRET + order ID: tidak perlu disimpan dan tidak bisa ditebak. */
export const tokenFor = (orderNo) => crypto.createHmac('sha256', config.appSecret).update(`order-token:${orderNo}`).digest('hex').slice(0, 40);
export const tokenOk = (orderNo, token) => typeof token === 'string' && token.length > 0 && safeEqual(token, tokenFor(orderNo));
