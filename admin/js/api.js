export class ApiError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
  get fields() { return this.details?.fields || {}; }
}

const bus = new EventTarget();
export const onUnauthorized = (fn) => bus.addEventListener('unauthorized', fn);

const qs = (params = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
};

async function request(url, { method = 'GET', body, form, auth = false } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : form,
    });
  } catch {
    throw new ApiError(0, 'Tidak dapat terhubung ke server. Periksa koneksi Anda.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !auth) bus.dispatchEvent(new Event('unauthorized'));
    throw new ApiError(res.status, data.error?.message || `Permintaan gagal (${res.status})`, data.error?.details);
  }
  return data;
}

const A = '/api/admin';
export const api = {
  get: (path, params) => request(A + path + qs(params)),
  post: (path, body) => request(A + path, { method: 'POST', body: body ?? {} }),
  put: (path, body) => request(A + path, { method: 'PUT', body }),
  patch: (path, body) => request(A + path, { method: 'PATCH', body }),
  del: (path, params) => request(A + path + qs(params), { method: 'DELETE' }),
  upload(file, folder) {
    const fd = new FormData();
    fd.append('folder', folder);
    fd.append('file', file);
    return request(`${A}/media`, { method: 'POST', form: fd });
  },
};

export const auth = {
  me: () => request(`${A}/auth/me`, { auth: true }),
  login: (email, password) => request(`${A}/auth/login`, { method: 'POST', body: { email, password }, auth: true }),
  logout: () => request(`${A}/auth/logout`, { method: 'POST', body: {}, auth: true }),
  updateProfile: (body) => request(`${A}/auth/me`, { method: 'PATCH', body }),
  changePassword: (body) => request(`${A}/auth/me/password`, { method: 'POST', body }),
};
