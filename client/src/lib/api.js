import { toast } from './toast.js';

// Called when the session is gone (401 outside /api/auth): the store goes back to the sign-in homepage.
let signedOut = null;
export const onSignedOut = (fn) => { signedOut = fn; };

async function request(method, url, body, { quiet } = {}) {
  const res = await fetch(url, {
    method,
    headers: body instanceof FormData || body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/')) {
      signedOut?.();
      throw Object.assign(new Error('Sign in required'), { status: 401 });
    }
    const msg = data?.error || data?.message || res.statusText || 'Request failed';
    if (!quiet) toast.error(msg);
    throw Object.assign(new Error(msg), { status: res.status, code: data?.code, user: data?.user });
  }
  return data;
}

export const api = {
  get: (url, opts) => request('GET', url, undefined, opts),
  post: (url, body = {}, opts) => request('POST', url, body, opts),
  put: (url, body = {}, opts) => request('PUT', url, body, opts),
  patch: (url, body = {}, opts) => request('PATCH', url, body, opts),
  del: (url, opts) => request('DELETE', url, undefined, opts),
  upload: (url, files) => {
    const fd = new FormData();
    for (const f of files) fd.append('file', f, f.webkitRelativePath || f.name);
    return request('POST', url, fd);
  },
};
