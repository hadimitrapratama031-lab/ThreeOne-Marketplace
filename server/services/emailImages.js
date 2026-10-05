/**
 * Gambar email (logo toko, gambar produk, ikon kontak) dilampirkan sebagai CID inline — port dari
 * emailInlineImages.service.js project lama. Server mengambil byte gambar dari storage lalu mengirimnya DI DALAM email,
 * sehingga tampil walau Gmail gagal memuat URL eksternal. Gagal mengambil satu aset hanya membuat aset itu memakai URL
 * eksternal biasa; email tetap terkirim. Tidak ada gambar yang dikarang.
 */
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES_PER_IMAGE = 3 * 1024 * 1024;
const MAX_TOTAL_EMBED_BYTES = 8 * 1024 * 1024;
const RENDERABLE = /\.(png|jpe?g|gif|webp)(\?|#|$)/i;   // SVG tidak didukung banyak email client

const EMBEDDABLE = [
  { field: 'logoUrl', raw: 'logoUrlRaw', contentId: 'brand-logo', filename: 'logo', label: 'logo toko' },
  { field: 'productImage', raw: 'productImageRaw', contentId: 'product-image', filename: 'produk', label: 'gambar produk' },
  { field: 'waIcon', raw: 'waIconRaw', contentId: 'wa-icon', filename: 'whatsapp-icon', label: 'ikon WhatsApp' },
  { field: 'discordIcon', raw: 'discordIconRaw', contentId: 'discord-icon', filename: 'discord-icon', label: 'ikon Discord' },
];
const ext = (ct) => (/png/i.test(ct) ? 'png' : /jpe?g/i.test(ct) ? 'jpg' : /gif/i.test(ct) ? 'gif' : /webp/i.test(ct) ? 'webp' : 'img');

export async function fetchImageBuffer(url) {
  if (!url) return { ok: false, reason: 'URL kosong' };
  if (!RENDERABLE.test(url)) return { ok: false, reason: 'ekstensi tidak didukung sebagai lampiran gambar email' };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
    if (!res.ok) return { ok: false, reason: `storage membalas HTTP ${res.status}` };
    const contentType = String(res.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^image\//i.test(contentType)) return { ok: false, reason: `Content-Type "${contentType || '(kosong)'}" bukan image/*` };
    const declared = Number(res.headers.get('content-length'));
    if (declared > MAX_BYTES_PER_IMAGE) return { ok: false, reason: 'gambar melebihi batas lampiran' };
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) return { ok: false, reason: 'buffer kosong' };
    if (buffer.length > MAX_BYTES_PER_IMAGE) return { ok: false, reason: 'gambar melebihi batas lampiran' };
    return { ok: true, buffer, contentType, size: buffer.length };
  } catch (err) {
    return { ok: false, reason: err?.name === 'TimeoutError' ? 'timeout' : String(err?.cause?.code || err?.message || err) };
  }
}

/** Mengubah ctx (salinan!) agar gambar memakai "cid:..." dan mengembalikan lampiran untuk Resend. */
export async function embedContextImages(ctx, { orderCode } = {}) {
  const attachments = [];
  let total = 0;
  const suffix = String(orderCode || 'preview').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'preview';
  for (const spec of EMBEDDABLE) {
    const rawUrl = ctx[spec.raw];
    if (!rawUrl || total >= MAX_TOTAL_EMBED_BYTES) continue;
    const r = await fetchImageBuffer(rawUrl);
    if (!r.ok) {
      console.warn(`[EmailEmbed] ${spec.label} tidak dilampirkan, memakai URL eksternal: ${r.reason}`);
      continue;
    }
    total += r.size;
    const contentId = `${spec.contentId}-${suffix}`;
    attachments.push({ filename: `${spec.filename}.${ext(r.contentType)}`, content: r.buffer.toString('base64'), content_type: r.contentType, content_id: contentId });
    ctx[spec.field] = `cid:${contentId}`;
  }
  return attachments;
}
