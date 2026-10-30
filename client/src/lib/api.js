import { toast } from './toast.js';

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
    const msg = data?.error || data?.message || res.statusText || 'Request failed';
    if (!quiet) toast.error(msg);
    throw new Error(msg);
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
