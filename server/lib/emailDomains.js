// Domain gratisan tidak boleh jadi alamat "From" toko: tidak bisa diautentikasi (SPF/DKIM/DMARC) atas nama toko di Resend
// dan terlihat seperti spoofing bagi server penerima (penyebab umum masuk Spam). Daftar sama dengan project lama.
const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.id', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'aol.com', 'protonmail.com', 'proton.me']);
export const isFreemailAddress = (email) => {
  const d = String(email || '').split('@')[1];
  return Boolean(d) && FREEMAIL.has(d.toLowerCase());
};
