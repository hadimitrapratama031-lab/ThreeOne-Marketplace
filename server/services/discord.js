import { getDiscordConfig } from './integrationSettings.js';
import { getSetting } from './settings.js';

/**
 * Discord — port dari discord.service.js project lama (31_Marketplace_lama), bukan sistem baru.
 *
 * Yang dipertahankan dari project lama:
 *  - REST API Discord saja (tanpa gateway/websocket): tidak ada proses bot yang harus hidup terus, jadi tidak ada reconnect
 *    yang perlu dijaga dan restart / hot reload tidak bisa membuat dua bot.
 *  - Bentuk hasil SAMA dengan fonnte.js dan resend.js ({ success, permanent, message, response, httpStatus, disabled }),
 *    sehingga notifications.js memakainya lewat deliverChannel() yang sudah ada: claim slot, retry terbatas, NotificationLog,
 *    dan Socket.IO admin ikut apa adanya.
 *  - Embed PAYMENT_SUCCESS (author + logo toko, heading di description, enam field berlabel emoji, banner produk di bawah,
 *    warna #41F097) dan embed DM Live Chat (warna #6D3BEE) — struktur, label, dan urutan field tidak diubah.
 *  - Klasifikasi error: sementara (timeout, 5xx, 429) boleh di-retry; permanen (token/channel/izin salah) tidak.
 *
 * Yang berbeda dari project lama (permintaan baru):
 *  - Token bot, Guild ID, Channel ID, dan User ID admin dibaca dari pengaturan Admin Web (MongoDB, token terenkripsi),
 *    dengan ENV sebagai nilai awal. Mode webhook tidak dibawa: URL webhook memuat rahasia di path-nya dan tidak punya Guild.
 *  - Guild ID dipakai memverifikasi bahwa channel memang milik server yang dipilih.
 *
 * Token tidak pernah masuk log, pesan error, maupun respons API.
 */
const API_BASE = 'https://discord.com/api/v10';
const TIMEOUT_MS = 15_000;
const USER_AGENT = 'DiscordBot (marketplace-platform, 1.0)';   // Discord menolak request REST tanpa User-Agent bergaya bot

// Warna dari template Discord existing (color: 4321431 = #41F097) dan warna identitas Marketplace (#6D3BEE) — sama dengan project lama.
const ACCENT_SUCCESS = 4321431;
const ACCENT_CHAT = 7158766;

const log = (level, meta) => console[level]('[Discord]', JSON.stringify(meta));   // hanya status/alasan, tidak pernah kredensial

/* ------------------------------------------------------------- transport */
/** Satu pintu ke REST Discord. Tidak pernah melempar: selalu { ok, status, data, failure }. */
async function request(token, method, path, body) {
  if (!token) return { ok: false, failure: { permanent: true, message: 'Token bot Discord belum diisi.', httpStatus: null } };
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const code = String(err?.cause?.code || err?.code || '');
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { ok: false, failure: { permanent: false, message: `Discord tidak dapat dihubungi${timeout ? ' (timeout)' : code ? ` (${code})` : ''}.`, httpStatus: null } };
  }
  let data = null;
  try { data = await res.json(); } catch { /* 204 / bukan JSON */ }
  if (res.ok) return { ok: true, status: res.status, data };
  return { ok: false, status: res.status, data, failure: classify(res.status, data) };
}

/** Sama dengan classifyTransportError project lama; pesan Discord (code 50001/50013) dibedakan agar admin tahu apa yang harus diperbaiki. */
function classify(httpStatus, data) {
  const providerMessage = data?.message ? String(data.message).slice(0, 160) : '';
  const code = data?.code;
  if (httpStatus >= 500) return { permanent: false, message: `Discord mengembalikan error server (HTTP ${httpStatus}).`, httpStatus };
  if (httpStatus === 429) return { permanent: false, message: 'Discord membatasi jumlah permintaan (HTTP 429).', httpStatus };
  if (httpStatus === 401) return { permanent: true, message: 'Token bot ditolak Discord (HTTP 401). Reset token di Developer Portal lalu simpan ulang di Admin Web.', httpStatus };
  if (httpStatus === 403) {
    return {
      permanent: true, httpStatus,
      message: code === 50007
        ? 'Discord menolak DM (HTTP 403). Admin harus satu server dengan bot dan mengizinkan direct message dari anggota server.'
        : 'Bot tidak punya akses ke channel ini (HTTP 403). Undang bot ke server dan beri izin View Channel, Send Messages, dan Embed Links di channel tujuan.',
    };
  }
  if (httpStatus === 404) return { permanent: true, message: 'Server, channel, atau pengguna Discord tidak ditemukan. Periksa Guild ID dan Channel ID.', httpStatus };
  return { permanent: true, message: providerMessage ? `Discord menolak permintaan: ${providerMessage}` : `Discord menolak permintaan (HTTP ${httpStatus}).`, httpStatus };
}

/* ---------------------------------------------------------------- embeds */
// Discord memangkas/menolak embed yang melebihi batasnya — dipangkas di sini supaya nama produk panjang tidak menggagalkan kirim.
function clamp(value, max) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
const field = (name, value, inline = true) => { const v = clamp(value, 1024); return v ? { name: clamp(name, 256), value: v, inline } : null; };
const httpUrl = (u) => (/^https?:\/\//i.test(u || '') ? String(u).trim() : '');

/**
 * Embed PAYMENT_SUCCESS — bentuk mengikuti project lama apa adanya ("Costumer" memang ejaan template asal).
 * Dibangun dari ctx yang SAMA dengan email dan WhatsApp (notifications.buildContext): angka, status, dan waktu tidak mungkin
 * berbeda antar channel. Tidak memuat code redeem — itu rahasia pembeli dan hanya dikirim ke pembeli.
 */
export function buildPaymentSuccessEmbed(ctx) {
  const storeName = clamp(ctx.storeName || 'Store', 256);
  const logoUrl = httpUrl(ctx.logoUrlRaw);
  const productImage = httpUrl(ctx.productImageRaw);
  const fields = [
    field('👤 Costumer', ctx.customerName, false),
    field('🛒 Product', ctx.quantity > 1 ? `${ctx.productName} x${ctx.quantity}` : ctx.productName, false),
    field('🆔 Order', ctx.orderCode, false),
    field('💰 Price', ctx.total, false),
    field('⌚ Payment Time', ctx.paidAt || ctx.orderedAt, false),
    field('📄 Status', ctx.statusLabel, false),
    // Field "Website": URL production dari project BARU (alamat publik toko), bukan domain project lama. Kosong = tidak ditampilkan.
    field('Website', ctx.storeUrl, false),
  ].filter(Boolean);
  const embed = {
    author: logoUrl ? { name: storeName, icon_url: logoUrl } : { name: storeName },
    description: '** :white_check_mark: Pembayaran Berhasil**\n',
    color: ACCENT_SUCCESS,
    fields,
    timestamp: new Date().toISOString(),
    footer: logoUrl ? { text: storeName, icon_url: logoUrl } : { text: storeName },
  };
  if (productImage) embed.image = { url: productImage };   // banner produk dari order ini, bukan thumbnail kecil
  return embed;
}

/** Embed DM Live Chat: nama customer, ID percakapan, isi pesan, waktu, foto (bila ada), dan tautan Admin Web (hanya bila ada alamat publik). */
export function buildLiveChatEmbed(ctx) {
  const fields = [
    field('👤 Customer', ctx.customerName, false),
    field('🆔 User ID', ctx.userId, false),
    field('💬 Pesan', ctx.text || (ctx.hasImage ? '(mengirim foto)' : '(pesan kosong)'), false),
    field('🕐 Waktu', ctx.time, false),
  ].filter(Boolean);
  if (ctx.openUrl) fields.push(field('🔗 Buka Live Chat', ctx.openUrl, false));
  const name = ctx.storeName || 'Live Chat';
  const embed = {
    author: ctx.storeLogo ? { name, icon_url: ctx.storeLogo } : { name },
    description: '**:speech_balloon: Live Chat Baru**\n',
    color: ACCENT_CHAT,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: name },
  };
  if (ctx.imageUrl) embed.image = { url: ctx.imageUrl };
  return embed;
}

/* ---------------------------------------------------------------- sending */
const NOT_ENABLED = { success: false, permanent: true, disabled: true, message: 'Discord belum diaktifkan/dikonfigurasi di Admin Web.' };

/** Kirim embed ke channel. Sukses hanya bila Discord membalas dengan id pesan yang benar-benar dibuat. */
async function postEmbed(cfg, embed) {
  if (!cfg.token || !cfg.channelId) return { success: false, permanent: true, message: 'Token bot dan Channel ID Discord wajib diisi.' };
  const r = await request(cfg.token, 'POST', `/channels/${cfg.channelId}/messages`, { embeds: [embed], allowed_mentions: { parse: [] } });
  if (!r.ok) { log('error', { action: 'send', httpStatus: r.failure.httpStatus, reason: r.failure.message }); return { success: false, ...r.failure }; }
  const id = r.data?.id;
  if (!id) return { success: false, permanent: false, message: 'Discord membalas tanpa id pesan — pengiriman tidak terkonfirmasi.', httpStatus: r.status };
  log('info', { action: 'send', messageId: id });
  return { success: true, permanent: false, message: '', response: { id }, httpStatus: r.status };
}

/** Dipakai notifications.js untuk event paymentSuccess (menghormati saklar Enabled). */
export async function sendPaymentSuccess(ctx) {
  const cfg = await getDiscordConfig();
  if (!cfg.ready) return NOT_ENABLED;
  return postEmbed(cfg, buildPaymentSuccessEmbed(ctx));
}

/**
 * DM ke akun Discord admin. WAJIB lewat bot (webhook tidak bisa DM). Dua langkah REST seperti project lama:
 * POST /users/@me/channels -> POST /channels/{id}/messages.
 */
async function postDirect(cfg, userId, embed) {
  const target = String(userId || '').trim();
  if (!/^\d{17,20}$/.test(target)) return { success: false, permanent: true, message: 'User ID Discord admin belum diisi atau bukan ID numerik.' };
  if (!cfg.token) return { success: false, permanent: true, message: 'Token bot Discord belum diisi.' };
  const dm = await request(cfg.token, 'POST', '/users/@me/channels', { recipient_id: target });
  if (!dm.ok) { log('error', { action: 'dm', httpStatus: dm.failure.httpStatus, reason: dm.failure.message }); return { success: false, ...dm.failure }; }
  if (!dm.data?.id) return { success: false, permanent: false, message: 'Discord tidak mengembalikan channel DM.' };
  const sent = await request(cfg.token, 'POST', `/channels/${dm.data.id}/messages`, { embeds: [embed], allowed_mentions: { parse: [] } });
  if (!sent.ok) { log('error', { action: 'dm', httpStatus: sent.failure.httpStatus, reason: sent.failure.message }); return { success: false, ...sent.failure }; }
  if (!sent.data?.id) return { success: false, permanent: false, message: 'Discord membalas tanpa id pesan — DM tidak terkonfirmasi.' };
  log('info', { action: 'dm', messageId: sent.data.id });
  return { success: true, permanent: false, message: '', response: { id: sent.data.id } };
}

/** Dipakai livechatNotify.js untuk setiap pesan baru dari customer. */
export async function sendLiveChatDM(ctx) {
  const cfg = await getDiscordConfig();
  if (!cfg.enabled || !cfg.liveChatDm || !cfg.adminUserId) return NOT_ENABLED;
  return postDirect(cfg, cfg.adminUserId, buildLiveChatEmbed(ctx));
}

/* ----------------------------------------------------- verify & test (Admin Web) */
/**
 * Memeriksa koneksi SUNGGUHAN ke Discord (bukan tebakan dari data tersimpan):
 *  1) token valid        -> GET /users/@me
 *  2) bot ada di server  -> GET /guilds/{guildId}            (bila Guild ID diisi)
 *  3) channel terjangkau -> GET /channels/{channelId}, dan milik Guild ID tersebut bila keduanya diisi
 */
export async function verifyConnection() {
  const cfg = await getDiscordConfig();
  if (!cfg.token) return { ok: false, message: 'Token bot belum diisi.' };
  const me = await request(cfg.token, 'GET', '/users/@me');
  if (!me.ok) return { ok: false, message: me.failure.message };
  const bot = { botName: me.data?.username || '', botId: me.data?.id || '' };

  if (cfg.guildId) {
    const g = await request(cfg.token, 'GET', `/guilds/${cfg.guildId}`);
    if (!g.ok) return { ok: false, ...bot, message: g.status === 404 || g.status === 403 ? 'Bot belum masuk ke server dengan Guild ID ini. Undang bot terlebih dahulu.' : g.failure.message };
  }
  if (cfg.channelId) {
    const c = await request(cfg.token, 'GET', `/channels/${cfg.channelId}`);
    if (!c.ok) return { ok: false, ...bot, message: c.failure.message };
    if (cfg.guildId && c.data?.guild_id && c.data.guild_id !== cfg.guildId) return { ok: false, ...bot, message: 'Channel ini bukan bagian dari server dengan Guild ID tersebut.' };
  } else {
    return { ok: false, ...bot, message: 'Channel ID belum diisi.' };
  }
  return { ok: true, ...bot, message: `Terhubung sebagai ${bot.botName || 'bot'}.` };
}

async function storeName() { try { return (await getSetting('branding'))?.name || 'Store'; } catch { return 'Store'; } }
const nowId = () => new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' });

/** Tombol "Kirim notifikasi uji": pesan sungguhan ke channel tersimpan (tanpa syarat saklar Enabled, agar kredensial baru bisa diuji dulu). */
export async function sendTestNotification() {
  const cfg = await getDiscordConfig();
  if (!cfg.usable) return { success: false, message: 'Isi dan simpan token bot dan Channel ID terlebih dahulu.' };
  const name = await storeName();
  const r = await postEmbed(cfg, {
    author: { name },
    description: '**:white_check_mark: Test Notification**\nNotifikasi Discord dari Admin Web berhasil terhubung ke channel ini.\n',
    color: ACCENT_SUCCESS,
    fields: [field('📄 Status', cfg.enabled ? 'Aktif — notifikasi pembayaran akan dikirim ke channel ini' : 'Belum diaktifkan di Admin Web', false), field('⌚ Waktu', nowId(), false)].filter(Boolean),
    timestamp: new Date().toISOString(),
    footer: { text: name },
  });
  return r.success ? { success: true, message: 'Notifikasi uji terkirim ke channel Discord.' } : { success: false, message: r.message || 'Gagal mengirim notifikasi uji.' };
}

/** Tombol "Kirim DM uji" untuk notifikasi Live Chat. */
export async function sendTestDirectMessage() {
  const cfg = await getDiscordConfig();
  if (!cfg.token) return { success: false, message: 'Isi dan simpan token bot terlebih dahulu.' };
  if (!cfg.adminUserId) return { success: false, message: 'Isi dan simpan User ID Discord admin terlebih dahulu.' };
  const r = await postDirect(cfg, cfg.adminUserId, buildLiveChatEmbed({
    storeName: await storeName(), customerName: 'Test dari Admin Web', userId: '—',
    text: 'Kalau DM ini sampai, notifikasi Live Chat sudah siap dipakai.', time: nowId(),
  }));
  return r.success ? { success: true, message: 'DM uji terkirim ke akun Discord admin.' } : { success: false, message: r.message || 'Gagal mengirim DM uji.' };
}
