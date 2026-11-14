'use strict';
// Sends one HTTP request with node:http or node:https. Only the user's own requests go out; the extension makes no
// other network call. Pure Node, no VS Code: the tests run it against a local server.
//
// Result: { status, statusText, httpVersion, headers: [[k, v]], body: Buffer (decoded from gzip, deflate or br),
//           bodyBytes (on the wire), truncated, url (after redirects), redirects: [{status, url}], timings: {...} }
// Timings (ms): dns, tcp, tls, ttfb (from the request being written to the first byte), download, total.
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { performance } = require('perf_hooks');
const { CookieJar } = require('./cookies');

const DEFAULTS = { timeoutMs: 30000, followRedirects: true, maxRedirects: 10, maxBodyBytes: 50 * 1024 * 1024, insecure: false, decompress: true };

class SendError extends Error {
  constructor(message, code, timings) { super(message); this.code = code; this.timings = timings; }
}

function friendly(e, url) {
  const code = (e && (e.code || (e.cause && e.cause.code))) || '';
  let host = '';
  try { host = new URL(url).host; } catch { /* keep empty */ }
  switch (code) {
    case 'ECONNREFUSED': return `Connection refused by ${host}. Is the server running on that port?`;
    case 'ENOTFOUND': case 'EAI_AGAIN': return `The host name ${host} could not be found (DNS lookup failed).`;
    case 'ECONNRESET': return `${host} closed the connection.`;
    case 'ETIMEDOUT': case 'ZOVO_TIMEOUT': return `No complete response from ${host} within the time limit.`;
    case 'EHOSTUNREACH': case 'ENETUNREACH': return `${host} is not reachable from this computer.`;
    case 'DEPTH_ZERO_SELF_SIGNED_CERT': case 'SELF_SIGNED_CERT_IN_CHAIN': case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE': case 'CERT_HAS_EXPIRED': case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `The TLS certificate of ${host} is not trusted (${code}). For a local test server, set "zovoRest.allowInsecureTls" to true.`;
    default: return `${e && e.message ? e.message : String(e)}${code && !String(e && e.message).includes(code) ? ` (${code})` : ''}`;
  }
}

function hasHeader(headers, name) {
  const n = name.toLowerCase();
  return headers.some(([k]) => String(k).toLowerCase() === n);
}

function decode(buf, encoding) {
  const enc = String(encoding || '').trim().toLowerCase();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    if (enc === 'deflate') { try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); } }
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
  } catch (e) { return buf; }
  return buf;
}

/** One HTTP exchange, no redirects. */
function once(opts, onAbort) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(opts.url); } catch { reject(new SendError(`"${opts.url}" is not a valid URL.`, 'BAD_URL')); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { reject(new SendError(`Only http and https URLs can be sent (this one starts with ${u.protocol}).`, 'BAD_URL')); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const t0 = performance.now();
    const t = { start: t0, dns: 0, tcp: 0, tls: 0, ttfb: 0, download: 0, total: 0 };
    let tLookup = t0, tConnect = t0, tSecure = t0, tWritten = t0, tFirst = 0;
    const body = opts.body == null ? null : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body), 'utf8');
    const raw = [];
    // A raw header array keeps duplicates and the user's spelling, but Node then adds no Host header itself.
    if (!hasHeader(opts.headers, 'host')) raw.push('Host', u.host);
    for (const [k, v] of opts.headers) raw.push(k, v);
    if (body && !hasHeader(opts.headers, 'content-length') && !hasHeader(opts.headers, 'transfer-encoding')) raw.push('Content-Length', String(body.length));
    let done = false;
    const req = lib.request({
      method: opts.method, protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined,
      path: `${u.pathname || '/'}${u.search}`, headers: raw, rejectUnauthorized: !opts.insecure,
      agent: false, servername: /^[\d.]+$|:/.test(u.hostname) ? undefined : u.hostname,
    });
    const timer = setTimeout(() => { if (!done) req.destroy(Object.assign(new Error('timeout'), { code: 'ZOVO_TIMEOUT' })); }, opts.timeoutMs);
    if (onAbort) onAbort(() => { if (!done) req.destroy(Object.assign(new Error('The request was cancelled.'), { code: 'ZOVO_CANCELLED' })); });
    req.on('socket', (s) => {
      s.once('lookup', () => { tLookup = performance.now(); });
      s.once('connect', () => { tConnect = performance.now(); });
      s.once('secureConnect', () => { tSecure = performance.now(); });
    });
    req.on('error', (e) => {
      if (done) return;
      done = true; clearTimeout(timer);
      t.total = performance.now() - t0;
      if (e.code === 'ZOVO_CANCELLED') reject(new SendError('The request was cancelled.', 'CANCELLED', t));
      else reject(new SendError(friendly(e, opts.url), e.code || 'NETWORK', t));
    });
    req.on('response', (res) => {
      tFirst = performance.now();
      const chunks = [];
      let size = 0, truncated = false;
      res.on('data', (c) => {
        size += c.length;
        if (size <= opts.maxBodyBytes) chunks.push(c);
        else truncated = true;
      });
      res.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(new SendError(friendly(e, opts.url), e.code || 'NETWORK', t)); } });
      res.on('end', () => {
        if (done) return;
        done = true; clearTimeout(timer);
        const tEnd = performance.now();
        const isTls = u.protocol === 'https:';
        t.dns = Math.max(0, tLookup - t0);
        t.tcp = Math.max(0, tConnect - Math.max(tLookup, t0));
        t.tls = isTls ? Math.max(0, tSecure - tConnect) : 0;
        t.ttfb = Math.max(0, tFirst - Math.max(tWritten, isTls ? tSecure : tConnect));
        t.download = Math.max(0, tEnd - tFirst);
        t.total = tEnd - t0;
        let buf = Buffer.concat(chunks);
        const enc = res.headers['content-encoding'];
        if (opts.decompress && enc && !truncated) buf = decode(buf, enc);
        const pairs = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
        resolve({ status: res.statusCode, statusText: res.statusMessage || '', httpVersion: res.httpVersion, headers: pairs, body: buf, bodyBytes: size, truncated, timings: t, url: opts.url });
      });
    });
    req.on('finish', () => { tWritten = performance.now(); });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Sends a request and follows redirects (unless followRedirects is false).
 * req: { method, url, headers: [[k, v]], body }. opts: { timeoutMs, followRedirects, maxRedirects, maxBodyBytes,
 * insecure, cookieJar (a CookieJar or null), signal: { onAbort(fn) } }.
 */
async function send(req, opts = {}) {
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  let method = String(req.method || 'GET').toUpperCase();
  let url = String(req.url || '').trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = (/^(localhost|127\.|\[::1\])/i.test(url) ? 'http://' : 'https://') + url;
  let headers = (req.headers || []).map(([k, v]) => [String(k), String(v)]);
  let body = req.body;
  if (!hasHeader(headers, 'user-agent')) headers.push(['User-Agent', o.userAgent || 'zovo-rest-client']);
  if (!hasHeader(headers, 'accept-encoding') && o.decompress) headers.push(['Accept-Encoding', 'gzip, deflate, br']);
  const redirects = [];
  const jar = o.cookieJar || null;
  const started = performance.now();
  for (let hop = 0; ; hop++) {
    const h = headers.slice();
    if (jar && !hasHeader(h, 'cookie')) { const c = jar.header(url); if (c) h.push(['Cookie', c]); }
    const res = await once({ method, url, headers: h, body, timeoutMs: o.timeoutMs, maxBodyBytes: o.maxBodyBytes, insecure: o.insecure, decompress: o.decompress }, o.signal && o.signal.onAbort);
    if (jar) for (const [k, v] of res.headers) if (k.toLowerCase() === 'set-cookie') jar.store(v, url);
    const loc = res.headers.find(([k]) => k.toLowerCase() === 'location');
    if (o.followRedirects && [301, 302, 303, 307, 308].includes(res.status) && loc && hop < o.maxRedirects) {
      let next;
      try { next = new URL(loc[1], url).toString(); } catch { return { ...res, redirects }; }
      redirects.push({ status: res.status, url, location: next });
      const crossOrigin = new URL(next).origin !== new URL(url).origin;
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = method === 'HEAD' ? 'HEAD' : 'GET'; body = null;
        headers = headers.filter(([k]) => !/^(content-type|content-length|transfer-encoding)$/i.test(k));
      }
      if (crossOrigin) headers = headers.filter(([k]) => !/^(authorization|cookie|proxy-authorization)$/i.test(k));
      url = next;
      continue;
    }
    res.redirects = redirects;
    res.url = url;
    res.timings.total = performance.now() - started;
    res.request = { method, url, headers: h, body: body == null ? null : Buffer.isBuffer(body) ? body.toString('utf8') : String(body) };
    return res;
  }
}

module.exports = { send, SendError, CookieJar, decode, friendly };
