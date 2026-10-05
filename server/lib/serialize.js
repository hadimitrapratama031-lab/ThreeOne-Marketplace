import { CONTACT_ICONS } from '../models/index.js';
import { config } from '../config/env.js';
import { publicUrl } from './r2.js';

// URL selalu dibentuk dari key + R2_PUBLIC_URL saat ini, jadi pindah ke custom domain tidak merusak data lama
const mediaUrl = (m) => (config.r2.publicUrl && m.key ? publicUrl(m.key) : m.url);

const iso = (d) => (d ? new Date(d).toISOString() : null);
const idStr = (d) => String(d._id);

export const mainImage = (p) => (p.media || []).find((m) => m.type === 'image') || null;

/* ---------- Publik (Marketplace) ---------- */
export function pubCategory(c) {
  return { id: idStr(c), name: c.name, order: c.order, updatedAt: iso(c.updatedAt) };
}

export function pubProductCard(p, catName) {
  return {
    id: p.productId,
    name: p.name,
    categoryId: String(p.category?._id || p.category),
    category: catName ?? '',
    price: p.price,
    stock: p.stock,
    description: p.description,
    imageUrl: mainImage(p) ? mediaUrl(mainImage(p)) : null,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
  };
}

export function pubProductDetail(p, catName) {
  const hasOld = p.oldPrice && p.oldPrice > p.price;
  return {
    ...pubProductCard(p, catName),
    oldPrice: hasOld ? p.oldPrice : null,
    discount: hasOld ? Math.round((1 - p.price / p.oldPrice) * 100) : 0,
    sold: p.sold || 0,
    about: String(p.about || '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean),
    specs: { min: p.specs?.min || [], rec: p.specs?.rec || [], source: p.specs?.source || '' },
    media: (p.media || []).map((m) => ({ type: m.type, url: mediaUrl(m) })),
  };
}

export function pubFaq(f) {
  return { id: idStr(f), q: f.question, a: f.answer, order: f.order, updatedAt: iso(f.updatedAt) };
}

export function pubContact(c) {
  return { id: idStr(c), label: c.label, value: c.value, href: c.href || '', icon: CONTACT_ICONS[c.icon] || CONTACT_ICONS.link, order: c.order, updatedAt: iso(c.updatedAt) };
}

export function pubReview(r, product) {
  return {
    id: idStr(r), productId: r.productId, name: r.name, stars: r.stars, text: r.text, date: iso(r.date),
    images: (r.images || []).map((i) => ({ url: mediaUrl(i) })), updatedAt: iso(r.updatedAt),
    // Hanya ada di daftar semua rating (halaman Rating); event realtime cukup membawa productId
    ...(product ? { product: { id: product.productId, name: product.name, imageUrl: mainImage(product) ? mediaUrl(mainImage(product)) : null } } : {}),
  };
}

/* ---------- Admin ---------- */
export function admCategory(c, productCount = 0) {
  return { id: idStr(c), name: c.name, order: c.order, active: c.active, productCount, createdAt: iso(c.createdAt), updatedAt: iso(c.updatedAt) };
}

export function admProduct(p, cat) {
  const c = cat || p.category;
  return {
    id: idStr(p),
    productId: p.productId,
    name: p.name,
    category: { id: String(c?._id || p.category), name: c?.name ?? '—', active: c?.active ?? true },
    price: p.price,
    oldPrice: p.oldPrice ?? null,
    stock: p.stock,
    sold: p.sold || 0,
    active: p.active,
    description: p.description,
    about: p.about,
    specs: { min: p.specs?.min || [], rec: p.specs?.rec || [], source: p.specs?.source || '' },
    gameInfo: {
      steamAppId: p.gameInfo?.steamAppId || '',
      developer: p.gameInfo?.developer || '',
      publisher: p.gameInfo?.publisher || '',
      releaseDate: p.gameInfo?.releaseDate || '',
      genres: p.gameInfo?.genres ? [...p.gameInfo.genres] : [],
      metacritic: p.gameInfo?.metacritic ?? null,
    },
    media: (p.media || []).map((m) => ({ type: m.type, key: m.key, url: mediaUrl(m) })),
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
  };
}

export function admFaq(f) {
  return { id: idStr(f), question: f.question, answer: f.answer, order: f.order, active: f.active, updatedAt: iso(f.updatedAt) };
}

export function admContact(c) {
  return { id: idStr(c), label: c.label, value: c.value, href: c.href || '', icon: c.icon, iconPath: CONTACT_ICONS[c.icon] || CONTACT_ICONS.link, order: c.order, active: c.active, updatedAt: iso(c.updatedAt) };
}

export function admReview(r, product) {
  return {
    id: idStr(r),
    productId: r.productId,
    productName: product?.name ?? '(produk dihapus)',
    name: r.name, stars: r.stars, text: r.text, date: iso(r.date), status: r.status,
    images: (r.images || []).map((i) => ({ key: i.key, url: mediaUrl(i) })),
    createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
  };
}

export function admAsset(a) {
  return { id: idStr(a), key: a.key, url: mediaUrl(a), kind: a.kind, mime: a.mime, size: a.size, folder: a.folder, originalName: a.originalName, status: a.status, owner: a.owner?.type ? { type: a.owner.type, id: a.owner.id } : null, createdAt: iso(a.createdAt) };
}
