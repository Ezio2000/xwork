export async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    let msg = `Error ${res.status}`;
    try {
      msg = JSON.parse(text).error || msg;
    } catch {}
    throw new Error(msg);
  }

  return res.json();
}
