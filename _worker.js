// Dripbox: a private drop box between your own devices.
// Cloudflare Pages (advanced mode) + one R2 bucket bound as BUCKET + a PASS secret (the password you give out).
// Optional ADMIN_PASS secret: logging in with it makes that device the owner, who sees every logged-in device,
// can sign any of them out and can change the shared password from inside the app.
// Optional vars: TTL_DAYS (auto-delete unpinned items, default 30, 0 = never), LIMIT_GB (default 9, under the free 10 GB).
// Billing guards: storage is capped below the free 10 GB (uploads in progress count too), and writes are counted per month
// and refused well before R2's free 1M "class A" operations. Reads can't pass the free 10M: every read goes through
// this Worker, and the free Workers plan stops at 100k requests a day (~3.1M a month).

const IDX = '_index.json';
const PART = 50 * 1024 * 1024;      // multipart part size (a request body may be at most 100 MB)
const SMALL = 95 * 1024 * 1024;     // above this the browser uploads in parts
const enc = new TextEncoder();

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const err = (msg, status = 400) => json({ error: msg }, status);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let keyCache = null;
async function hmacKey(env) {
  if (keyCache && keyCache.p === env.PASS) return keyCache.k;
  const raw = await crypto.subtle.digest('SHA-256', enc.encode('cutie:' + env.PASS));
  const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  keyCache = { p: env.PASS, k };
  return k;
}
async function sign(env, msg) {
  return b64u(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(msg)));
}
function same(a, b) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
function cookie(req, name) {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
// --- sessions: every login is a row in _sessions.json, so the owner can see and remove any of them
const SESS = '_sessions.json';
const AUTH = '_auth.json';
async function readJson(env, key, empty) {
  const o = await env.BUCKET.get(key);
  if (!o) return { data: empty(), etag: null };
  return { data: await o.json(), etag: o.etag };
}
async function mutateJson(env, key, empty, fn) {
  for (let i = 0; i < 8; i++) {
    const { data, etag } = await readJson(env, key, empty);
    if ((await fn(data)) === false) return data;
    const put = await env.BUCKET.put(key, JSON.stringify(data), { httpMetadata: { contentType: 'application/json' }, ...(etag ? { onlyIf: { etagMatches: etag } } : {}) });
    if (put) return data;
    await sleep(40 + Math.random() * 120);
  }
  throw new Error('busy');
}
const noSess = () => ({ s: {} });
const mutateSess = (env, fn) => mutateJson(env, SESS, noSess, fn);
function describeUA(ua) {
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iPhone' : /Windows/i.test(ua) ? 'Windows' : /Mac OS/i.test(ua) ? 'Mac' : /Linux|CrOS/i.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return [br, os].filter(Boolean).join(' pe ') || 'Browser necunoscut';
}
const placeOf = (req) => [req.cf?.city, req.cf?.country].filter(Boolean).join(', ');
const devName = (req) => { try { return clean(decodeURIComponent(req.headers.get('x-dev') || ''), 40); } catch { return ''; } };

async function authed(req, env, ctx) {
  const c = cookie(req, 'cutie');
  if (!c) return null;
  const [sid, exp, sig] = c.split('.');
  if (!sid || !exp || !sig || Number(exp) < Date.now() / 1000) return null;
  if (!same(sig, await sign(env, `auth:${sid}:${exp}`))) return null;
  const { data } = await readJson(env, SESS, noSess);
  const s = data.s[sid];
  if (!s) return null;   // signed out by the owner
  const dev = devName(req);
  // "last seen" is refreshed at most every 10 minutes, so watching the list costs almost no writes
  if (Date.now() - (s.seen || 0) > 10 * 60e3 || (dev && dev !== s.dev)) {
    const touch = mutateSess(env, (d) => {
      const x = d.s[sid];
      if (!x) return false;
      x.seen = Date.now();
      if (dev) x.dev = dev;
      x.where = placeOf(req) || x.where;
    }).catch(() => {});
    if (ctx) ctx.waitUntil(touch);
  }
  return { sid, ...s };
}
async function checkPass(env, pass) {
  const h = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const p = await h(String(pass || ''));
  if (env.ADMIN_PASS && eq(p, await h(env.ADMIN_PASS))) return 'admin';
  // the shared password: the one set from the app (stored salted) wins over the PASS secret
  const { data } = await readJson(env, AUTH, () => null);
  if (data && data.hash) {
    if (eq(await h(data.salt + ':' + String(pass || '')), Uint8Array.from(atob(data.hash), (ch) => ch.charCodeAt(0)))) return 'user';
    return null;
  }
  return env.PASS && eq(p, await h(env.PASS)) ? 'user' : null;
}

// --- the index: one small JSON object, updated with compare-and-swap so two devices never overwrite each other
async function readIndex(env) {
  const o = await env.BUCKET.get(IDX);
  if (!o) return { data: { items: [], cleaned: Date.now() }, etag: null };
  return { data: await o.json(), etag: o.etag };
}
async function mutate(env, fn) {
  for (let i = 0; i < 8; i++) {
    const { data, etag } = await readIndex(env);
    const out = await fn(data);
    if (out === false) return data;
    spend(data, 1);
    const body = JSON.stringify(data);
    const put = await env.BUCKET.put(IDX, body, { httpMetadata: { contentType: 'application/json' }, ...(etag ? { onlyIf: { etagMatches: etag } } : {}) });
    if (put) return data;
    await sleep(40 + Math.random() * 120);
  }
  throw new Error('index busy');
}
const used = (data) => data.items.reduce((s, x) => s + (x.s || 0), 0)
  + Object.values(data.pending || {}).filter((p) => Date.now() - p.at < 2 * 86400e3).reduce((s, p) => s + p.size, 0);
const limit = (env) => Math.round(Math.min(Number(env.LIMIT_GB || 9), 9.5) * 1024 ** 3);
const WRITE_CAP = 600000;   // R2 gives 1M class A operations a month for free; stop well before
const month = () => new Date().toISOString().slice(0, 7);
function spend(data, ops) {
  if (data.month !== month()) { data.month = month(); data.ops = 0; }
  data.ops = (data.ops || 0) + ops;
}
const overBudget = (data) => data.month === month() && (data.ops || 0) > WRITE_CAP;
const FULL = 'Nu mai e loc în limita gratuită. Șterge ceva întâi.';
const BUSY = 'Limita gratuită de scrieri pe luna asta e aproape atinsă; merge din nou de la 1 ale lunii.';
const ttl = (env) => Number(env.TTL_DAYS ?? 30);
const newId = () => {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return b64u(a);
};
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

async function cleanup(env) {
  const days = ttl(env);
  const gone = [];
  await mutate(env, (data) => {
    data.cleaned = Date.now();
    if (!days) return;
    const cut = Date.now() - days * 86400e3;
    data.items = data.items.filter((x) => {
      if (!x.pin && x.at < cut) { gone.push(x); return false; }
      return true;
    });
  });
  for (const x of gone) if (x.k === 'f') await env.BUCKET.delete('f/' + x.id);
}

async function addItem(env, item, ops = 0, pendingId = null) {
  await mutate(env, (data) => {
    data.items.unshift(item);
    if (ops) spend(data, ops);
    if (pendingId && data.pending) delete data.pending[pendingId];
  });
  return item;
}

// --- files out
function disposition(name, inline) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
function parseRange(h) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((h || '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) return { suffix: Number(m[2]) };
  return m[2] ? { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 } : { offset: Number(m[1]) };
}
async function serveFile(req, env, id, name, dl) {
  const range = parseRange(req.headers.get('range'));
  const opts = { onlyIf: req.headers };
  if (range) opts.range = range;
  const obj = await env.BUCKET.get('f/' + id, opts);
  if (!obj) return new Response('Nu mai există.', { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set('etag', obj.httpEtag);
  h.set('accept-ranges', 'bytes');
  h.set('cache-control', 'private, max-age=31536000, immutable');
  h.set('x-content-type-options', 'nosniff');
  const type = (h.get('content-type') || '').toLowerCase();
  // a stored web page or SVG must not run as part of this site
  if (/html|svg|xml|javascript/.test(type)) h.set('content-security-policy', 'sandbox');
  h.set('content-disposition', disposition(name || obj.customMetadata?.name || 'fisier', !dl));
  if (!('body' in obj)) return new Response(null, { status: 304, headers: h });
  let status = 200;
  if (range) {
    const start = 'suffix' in range ? Math.max(0, obj.size - range.suffix) : range.offset;
    const len = 'suffix' in range ? obj.size - start : Math.min(range.length ?? obj.size - start, obj.size - start);
    h.set('content-range', `bytes ${start}-${start + len - 1}/${obj.size}`);
    h.set('content-length', String(len));
    status = 206;
  } else {
    h.set('content-length', String(obj.size));
  }
  return new Response(obj.body, { status, headers: h });
}

// --- API
async function api(req, env, ctx, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/login' && m === 'POST') {
    if (!env.PASS) return err('Lipsește parola (secretul PASS) în setările Cloudflare.', 500);
    const b = await req.json().catch(() => ({}));
    const role = await checkPass(env, b.pass);
    if (!role) { await sleep(900); return err('Parolă greșită.', 401); }
    const sid = newId();
    const exp = Math.floor(Date.now() / 1000) + 400 * 86400;
    const now = Date.now();
    await mutateSess(env, (d) => {
      // forget sessions that expired or haven't been used for 120 days
      for (const [k, x] of Object.entries(d.s)) if (now - (x.seen || x.at) > 120 * 86400e3) delete d.s[k];
      d.s[sid] = { dev: clean(b.device, 40) || 'Dispozitiv', ua: describeUA(req.headers.get('user-agent') || ''), where: placeOf(req), at: now, seen: now, admin: role === 'admin' };
    });
    const secure = url.protocol === 'https:' ? '; Secure' : '';
    return json({ ok: true, admin: role === 'admin' }, 200, { 'set-cookie': `cutie=${sid}.${exp}.${await sign(env, `auth:${sid}:${exp}`)}; Path=/; Max-Age=${400 * 86400}; HttpOnly; SameSite=Lax${secure}` });
  }
  if (p === '/api/logout' && m === 'POST') {
    const me = await authed(req, env, null);
    if (me) await mutateSess(env, (d) => { if (!d.s[me.sid]) return false; delete d.s[me.sid]; });
    return json({ ok: true }, 200, { 'set-cookie': 'cutie=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' });
  }

  const me = await authed(req, env, ctx);
  if (!me) return err('Neautentificat.', 401);

  if (p === '/api/me' && m === 'GET') return json({ admin: !!me.admin, dev: me.dev });

  // --- owner only: who is logged in, sign devices out, change the shared password
  if (p.startsWith('/api/admin/')) {
    if (!me.admin) return err('Doar proprietarul poate face asta.', 403);
    if (p === '/api/admin/sessions' && m === 'GET') {
      const { data } = await readJson(env, SESS, noSess);
      const list = Object.entries(data.s).map(([id, x]) => ({ id, ...x, me: id === me.sid })).sort((a, b) => b.seen - a.seen);
      const { data: auth } = await readJson(env, AUTH, () => null);
      return json({ sessions: list, customPass: !!(auth && auth.hash) });
    }
    let am = p.match(/^\/api\/admin\/sessions\/([\w-]+)$/);
    if (am && m === 'DELETE') {
      if (am[1] === me.sid) return err('Pentru dispozitivul ăsta folosește „Ieși”.');
      await mutateSess(env, (d) => { if (!d.s[am[1]]) return false; delete d.s[am[1]]; });
      return json({ ok: true });
    }
    if (p === '/api/admin/kick' && m === 'POST') {
      const b = await req.json().catch(() => ({}));
      let n = 0;
      await mutateSess(env, (d) => {
        n = 0;
        for (const [k, x] of Object.entries(d.s)) if (k !== me.sid && (b.all || !x.admin)) { delete d.s[k]; n++; }
        if (!n) return false;
      });
      return json({ ok: true, removed: n });
    }
    if (p === '/api/admin/password' && m === 'POST') {
      const b = await req.json().catch(() => ({}));
      const pass = String(b.pass || '');
      if (pass.length < 8) return err('Parola nouă trebuie să aibă cel puțin 8 caractere.');
      if (env.ADMIN_PASS && pass === env.ADMIN_PASS) return err('Alege altă parolă decât parola ta de proprietar.');
      const salt = newId();
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(salt + ':' + pass)));
      await env.BUCKET.put(AUTH, JSON.stringify({ salt, hash: btoa(String.fromCharCode(...digest)), at: Date.now() }), { httpMetadata: { contentType: 'application/json' } });
      let n = 0;
      if (b.kick !== false) await mutateSess(env, (d) => { n = 0; for (const [k, x] of Object.entries(d.s)) if (!x.admin) { delete d.s[k]; n++; } if (!n) return false; });
      return json({ ok: true, removed: n });
    }
    return err('Nu există.', 404);
  }

  if (p === '/api/list' && m === 'GET') {
    const inm = (req.headers.get('if-none-match') || '').replace(/^W\//, '').replace(/"/g, '');
    const o = await env.BUCKET.get(IDX, inm ? { onlyIf: { etagDoesNotMatch: inm } } : {});
    if (o && !('body' in o)) return new Response(null, { status: 304, headers: { etag: o.httpEtag, 'cache-control': 'no-store' } });
    const data = o ? await o.json() : { items: [], cleaned: Date.now() };
    if (Date.now() - (data.cleaned || 0) > 6 * 3600e3) ctx.waitUntil(cleanup(env));
    return json({ items: data.items, used: used(data), limit: limit(env), ttl: ttl(env), part: PART, small: SMALL, ops: data.month === month() ? data.ops || 0 : 0, opsCap: WRITE_CAP }, 200, o ? { etag: o.httpEtag } : {});
  }

  if (p === '/api/text' && m === 'POST') {
    const b = await req.json().catch(() => ({}));
    const text = String(b.text || '').slice(0, 200000);
    if (!text.trim()) return err('Mesaj gol.');
    const { data } = await readIndex(env);
    if (overBudget(data)) return err(BUSY, 429);
    return json(await addItem(env, { id: newId(), k: 't', text, s: 0, at: Date.now(), from: clean(b.from, 40) }));
  }

  if (p === '/api/up' && m === 'PUT') {
    const size = Number(req.headers.get('content-length') || url.searchParams.get('size') || 0);
    const { data } = await readIndex(env);
    if (overBudget(data)) return err(BUSY, 429);
    if (!size || used(data) + size > limit(env)) return err(size ? FULL : 'Lipsește mărimea fișierului.', 413);
    const id = newId();
    const name = clean(url.searchParams.get('name'), 200) || 'fisier';
    const type = clean(url.searchParams.get('type'), 120) || 'application/octet-stream';
    const o = await env.BUCKET.put('f/' + id, req.body, { httpMetadata: { contentType: type }, customMetadata: { name } });
    const cap = String(url.searchParams.get('cap') || '').slice(0, 1000).trim();
    return json(await addItem(env, { id, k: 'f', n: name, m: type, s: o.size, at: Date.now(), from: clean(url.searchParams.get('from'), 40), ...(cap ? { c: cap } : {}) }, 1));
  }

  if (p === '/api/mpu/start' && m === 'POST') {
    const b = await req.json();
    const size = Number(b.size || 0);
    if (!(size > 0)) return err('Lipsește mărimea fișierului.');
    const id = newId();
    let refuse = null;
    // reserve the space first, so two big uploads at once can't pass the cap together
    await mutate(env, (data) => {
      if (overBudget(data)) { refuse = [BUSY, 429]; return false; }
      if (used(data) + size > limit(env)) { refuse = [FULL, 413]; return false; }
      data.pending = Object.fromEntries(Object.entries(data.pending || {}).filter(([, p]) => Date.now() - p.at < 2 * 86400e3));
      data.pending[id] = { size, at: Date.now() };
      spend(data, 2 + Math.ceil(size / PART));   // create + parts + complete
    });
    if (refuse) return err(...refuse);
    const name = clean(b.name, 200) || 'fisier';
    const up = await env.BUCKET.createMultipartUpload('f/' + id, { httpMetadata: { contentType: clean(b.type, 120) || 'application/octet-stream' }, customMetadata: { name } });
    return json({ id, uploadId: up.uploadId, part: PART });
  }
  if (p === '/api/mpu/part' && m === 'PUT') {
    const id = url.searchParams.get('id');
    const n = Number(url.searchParams.get('n'));
    const { data } = await readIndex(env);
    const pend = (data.pending || {})[id];
    if (!pend || !(n >= 1 && n <= Math.ceil(pend.size / PART))) return err('Încărcare necunoscută.', 400);
    const up = env.BUCKET.resumeMultipartUpload('f/' + id, url.searchParams.get('uploadId'));
    const part = await up.uploadPart(n, req.body);
    return json(part);
  }
  if (p === '/api/mpu/done' && m === 'POST') {
    const b = await req.json();
    const up = env.BUCKET.resumeMultipartUpload('f/' + b.id, b.uploadId);
    const o = await up.complete(b.parts);
    return json(await addItem(env, { id: b.id, k: 'f', n: clean(b.name, 200) || 'fisier', m: clean(b.type, 120) || 'application/octet-stream', s: o.size, at: Date.now(), from: clean(b.from, 40), ...(String(b.cap || '').trim() ? { c: String(b.cap).slice(0, 1000).trim() } : {}) }, 0, b.id));
  }
  if (p === '/api/mpu/abort' && m === 'POST') {
    const b = await req.json();
    try { await env.BUCKET.resumeMultipartUpload('f/' + b.id, b.uploadId).abort(); } catch {}
    await mutate(env, (data) => { if (!data.pending || !data.pending[b.id]) return false; delete data.pending[b.id]; });
    return json({ ok: true });
  }

  let mm = p.match(/^\/api\/item\/([\w-]+)$/);
  if (mm && m === 'DELETE') {
    let hit = null;
    await mutate(env, (data) => {
      const i = data.items.findIndex((x) => x.id === mm[1]);
      if (i < 0) return false;
      hit = data.items.splice(i, 1)[0];
    });
    if (hit && hit.k === 'f') await env.BUCKET.delete('f/' + hit.id);
    return json({ ok: true });
  }
  if (mm && m === 'PATCH') {
    const b = await req.json();
    await mutate(env, (data) => {
      const x = data.items.find((x) => x.id === mm[1]);
      if (!x) return false;
      if ('pin' in b) x.pin = !!b.pin;
    });
    return json({ ok: true });
  }
  mm = p.match(/^\/api\/link\/([\w-]+)$/);
  if (mm && m === 'POST') {
    const b = await req.json().catch(() => ({}));
    const { data } = await readIndex(env);
    const x = data.items.find((x) => x.id === mm[1] && x.k === 'f');
    if (!x) return err('Nu există.', 404);
    const days = Math.min(Math.max(Number(b.days) || 7, 1), 30);
    const exp = Math.floor(Date.now() / 1000) + days * 86400;
    const sig = (await sign(env, `s:${x.id}:${exp}`)).slice(0, 22);
    return json({ url: `${url.origin}/s/${x.id}/${exp}/${sig}/${encodeURIComponent(x.n)}`, exp });
  }
  return err('Nu există.', 404);
}

// files shared from the phone's Share menu before the app's service worker is ready
async function shareFallback(req, env) {
  if (!(await authed(req, env, null))) return Response.redirect(new URL('/?share=login', req.url).toString(), 303);
  const fd = await req.formData();
  const from = 'Telefon';
  const files = fd.getAll('f').filter((f) => typeof f !== 'string' && f.size);
  let parts = [...new Set(['title', 'text', 'url'].map((k) => fd.get(k)).filter((v) => typeof v === 'string' && v.trim()))];
  // with files, Android adds a label like "Screenshot (26 Oct 2026 21:40)": keep only a real link, as the caption
  if (files.length) parts = parts.filter((v) => /https?:\/\//.test(v));
  const text = parts.join('\n').slice(0, 1000);
  let first = true;
  for (const f of files) {
    const { data } = await readIndex(env);
    if (overBudget(data) || used(data) + f.size > limit(env)) break;
    const id = newId();
    const name = clean(f.name, 200) || 'fisier';
    const o = await env.BUCKET.put('f/' + id, f.stream(), { httpMetadata: { contentType: f.type || 'application/octet-stream' }, customMetadata: { name } });
    await addItem(env, { id, k: 'f', n: name, m: f.type || 'application/octet-stream', s: o.size, at: Date.now(), from, ...(first && text ? { c: text } : {}) }, 1);
    first = false;
  }
  if (text && !files.length) await addItem(env, { id: newId(), k: 't', text, s: 0, at: Date.now(), from });
  return Response.redirect(new URL('/', req.url).toString(), 303);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (!env.BUCKET) return new Response('Lipsește legătura cu bucket-ul R2 (BUCKET) în setările proiectului Pages.', { status: 500 });
      if (url.pathname.startsWith('/api/')) return await api(req, env, ctx, url);
      let mm = url.pathname.match(/^\/f\/([\w-]+)(?:\/.*)?$/);
      if (mm) {
        if (!(await authed(req, env, ctx))) return Response.redirect(new URL('/', req.url).toString(), 302);
        return await serveFile(req, env, mm[1], null, url.searchParams.has('dl'));
      }
      mm = url.pathname.match(/^\/s\/([\w-]+)\/(\d+)\/([\w-]+)(?:\/(.*))?$/);
      if (mm) {
        const [, id, exp, sig] = mm;
        if (Number(exp) < Date.now() / 1000) return new Response('Linkul a expirat.', { status: 410, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        if (!same(sig, (await sign(env, `s:${id}:${exp}`)).slice(0, 22))) return new Response('Link greșit.', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        return await serveFile(req, env, id, mm[4] ? decodeURIComponent(mm[4]) : null, url.searchParams.has('dl'));
      }
      if (url.pathname === '/share' && req.method === 'POST') return await shareFallback(req, env);
      return env.ASSETS.fetch(req);
    } catch (e) {
      return err('Eroare: ' + (e && e.message || e), 500);
    }
  },
};
