import { z } from 'zod';
import { normalizeWhatsapp } from './phone.js';

// Buang karakter kontrol (kecuali \n \t) dari teks yang berasal dari pengguna
const clean = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\r\n?/g, '\n');
const idLike = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'ID tidak valid');

export const createConversationInput = z.object({
  name: z.string({ required_error: 'Nama wajib diisi' }).transform((v) => clean(v).replace(/\s+/g, ' ').trim()).pipe(z.string().min(2, 'Nama minimal 2 karakter').max(60, 'Nama maksimal 60 karakter')),
  whatsapp: z.string().trim().max(25, 'Nomor terlalu panjang').optional().default('').transform((v, ctx) => {
    if (!v) return '';
    const n = normalizeWhatsapp(v);
    if (!n) { ctx.addIssue({ code: 'custom', message: 'Nomor WhatsApp tidak valid (contoh: 0812 3456 7890)' }); return z.NEVER; }
    return n;
  }),
  clientKey: idLike.refine((v) => v.length >= 16, 'ID tidak valid'),
});

export const messageInput = z.object({
  clientId: idLike,
  type: z.enum(['text', 'image']).default('text'),
  text: z.string().max(4000, 'Pesan terlalu panjang').optional().default('').transform((v) => clean(v).replace(/\n{4,}/g, '\n\n\n').trim()),
}).superRefine((v, ctx) => {
  if (v.type === 'text' && !v.text) ctx.addIssue({ code: 'custom', path: ['text'], message: 'Pesan tidak boleh kosong' });
  if (v.type === 'text' && v.text.length > 1000) ctx.addIssue({ code: 'custom', path: ['text'], message: 'Maksimal 1000 karakter' });
});

export const readInput = z.object({ upToSeq: z.number().int().min(0).max(1_000_000) });

export const adminListQuery = z.object({
  filter: z.enum(['active', 'unread', 'closed', 'expired']).default('active'),
  q: z.string().trim().max(80).optional().default(''),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(60).default(30),
});

export const livechatSettingsInput = z.object({
  enabled: z.boolean(),
  waNumber: z.string().trim().max(25).optional().default(''),
  notifyNewConversation: z.boolean().optional().default(true),
  notifyNewMessage: z.boolean().optional().default(true),
  messageCooldownSec: z.number().int().refine((n) => [0, 30, 60, 300].includes(n), 'Pilihan tidak valid').optional().default(0),
});
