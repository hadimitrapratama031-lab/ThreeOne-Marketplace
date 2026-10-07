import { toast } from './ui.js';
import { api } from './api.js';

/**
 * Inti notifikasi Live Chat untuk Admin Web — hidup di SEMUA halaman admin (dipasang sekali oleh app.js pada socket admin
 * yang sudah ada), bukan hanya di halaman Live Chat: badge unread, judul tab, toast, dan suara tetap bekerja di halaman mana pun.
 *
 * Anti dobel:
 *  - `seen` (id pesan / id percakapan): event yang sama tidak membunyikan suara dua kali (reconnect, resync, event ganda).
 *  - Web Locks (bila ada): beberapa tab admin terbuka -> hanya satu tab yang berbunyi untuk event yang sama.
 */
const SOUND_KEY = 'mp_admin_chat_sound';
const SEEN_MAX = 500;

let unread = 0;
let soundOn = (() => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; } })();
let audio = null;
let unlocked = false;
let warnedLocked = false;
let baseTitle = document.title;
let viewing = null;                 // conversationId yang sedang dibuka di halaman Live Chat (tab terlihat)
const seen = new Set();
const subs = new Set();

const remember = (key) => {
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
  return true;
};

/* ---------- suara: dibuat dengan WebAudio (tanpa file aset), dibuka oleh gesture pertama pengguna ---------- */
function unlock() {
  if (unlocked) return;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    audio.resume?.().then(() => { unlocked = audio.state === 'running'; notify(); }).catch(() => {});
  } catch { /* browser tanpa WebAudio */ }
}
['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, unlock, { passive: true }));

function chime() {
  if (!audio || audio.state !== 'running') return false;
  const t0 = audio.currentTime;
  [[880, 0], [1318.5, 0.16]].forEach(([freq, at]) => {   // dua nada lembut, naik
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + at);
    gain.gain.exponentialRampToValueAtTime(0.22, t0 + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.42);
    osc.connect(gain).connect(audio.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + 0.45);
  });
  return true;
}

function ring(id) {
  if (!soundOn || !remember(`ring:${id}`)) return;
  const play = () => {
    if (chime()) return;
    if (!warnedLocked) { warnedLocked = true; toast('Klik di mana saja untuk mengaktifkan suara notifikasi', { type: 'ok', detail: 'Browser memblokir suara sebelum ada interaksi.' }); }
  };
  if (navigator.locks?.request) {
    navigator.locks.request(`mp-livechat-ring:${id}`, { ifAvailable: true }, async (lock) => {
      if (!lock) return;               // tab lain sudah membunyikan event ini
      play();
      await new Promise((r) => setTimeout(r, 8000));   // tahan kunci sebentar agar tab lain tidak ikut berbunyi
    });
  } else play();
}

/* ---------- badge & judul ---------- */
function paint() {
  document.querySelectorAll('[data-chat-badge]').forEach((b) => { b.hidden = unread <= 0; b.textContent = unread > 99 ? '99+' : String(unread); });
  document.title = unread > 0 ? `(${unread}) ${baseTitle}` : baseTitle;
}
function notify() { subs.forEach((fn) => fn({ unread, soundOn, unlocked })); }
function setUnread(n) {
  const next = Math.max(0, Number(n) || 0);
  if (next === unread) return;
  unread = next;
  paint(); notify();
}

export const chatCore = {
  get unread() { return unread; },
  get soundOn() { return soundOn; },
  get unlocked() { return unlocked; },
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  setSound(on) {
    soundOn = Boolean(on);
    try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* abaikan */ }
    if (on) { unlock(); setTimeout(() => chime(), 80); }   // pratinjau singkat sekaligus membuka kunci audio
    notify();
  },
  setViewing(id) { viewing = id; },
  /** Dipanggil app.js saat judul halaman berubah. */
  setTitle(title) { baseTitle = title; paint(); },
  /** Paint ulang badge setelah nav dibangun. */
  paint,
  setUnread,

  async init() {
    try { setUnread((await api.get('/livechat/summary')).totalUnread); } catch { /* sidebar tetap berfungsi tanpa badge */ }
    paint();
  },

  /** Event Live Chat dari socket admin. */
  async onLive(evt, p) {
    if (evt === 'resync') {   // setelah reconnect: pesan yang masuk saat terputus tidak punya event, jadi bandingkan total
      const before = unread;
      try { const { totalUnread } = await api.get('/livechat/summary'); setUnread(totalUnread); if (totalUnread > before) ring(`resync:${totalUnread}`); } catch { /* coba lagi pada resync berikutnya */ }
      return;
    }
    if (typeof p?.totalUnread === 'number') setUnread(p.totalUnread);
    if (evt === 'livechat:conversation:created') {
      remember(`conv:${p.conversation.id}`);
      ring(`conv:${p.conversation.id}`);
      toast('Percakapan baru', { detail: `${p.conversation.name} membuka Live Chat.` });
    } else if (evt === 'livechat:message:new' && p.message.sender === 'customer') {
      ring(p.message.id);
      const watching = viewing === p.conversationId && document.visibilityState === 'visible';
      if (!watching && remember(`toast:${p.message.id}`)) {
        const body = p.message.type === 'image' ? 'Mengirim gambar' : p.message.text.slice(0, 80);
        toast(`Pesan baru dari ${p.conversation.name}`, { detail: body });
      }
    }
  },
};
