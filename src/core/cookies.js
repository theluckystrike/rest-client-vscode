'use strict';
// An in-memory cookie jar for one VS Code window: Set-Cookie from responses, Cookie on later requests to the same
// site. Domain, path, Secure, Max-Age and Expires are honoured. Nothing is written to disk.

function parseSetCookie(value, url) {
  const parts = String(value).split(';');
  const first = parts.shift();
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const u = new URL(url);
  const c = { name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim(), domain: u.hostname.toLowerCase(), hostOnly: true, path: '/', secure: false, httpOnly: false, expires: null };
  const dir = u.pathname.replace(/\/[^/]*$/, '');
  c.path = dir && dir.startsWith('/') ? dir : '/';
  for (const p of parts) {
    const i = p.indexOf('=');
    const k = (i < 0 ? p : p.slice(0, i)).trim().toLowerCase();
    const v = i < 0 ? '' : p.slice(i + 1).trim();
    if (k === 'domain' && v) {
      const d = v.replace(/^\./, '').toLowerCase();
      if (c.domain === d || c.domain.endsWith('.' + d)) { c.domain = d; c.hostOnly = false; } else return null; // a site may not set cookies for another
    } else if (k === 'path' && v.startsWith('/')) c.path = v;
    else if (k === 'secure') c.secure = true;
    else if (k === 'httponly') c.httpOnly = true;
    else if (k === 'max-age') { const n = Number(v); if (Number.isFinite(n)) c.expires = Date.now() + n * 1000; }
    else if (k === 'expires' && c.expires === null) { const t = Date.parse(v); if (Number.isFinite(t)) c.expires = t; }
  }
  return c;
}

class CookieJar {
  constructor() { this.cookies = []; }
  store(setCookie, url) {
    let c;
    try { c = parseSetCookie(setCookie, url); } catch { return; }
    if (!c) return;
    this.cookies = this.cookies.filter((x) => !(x.name === c.name && x.domain === c.domain && x.path === c.path));
    if (c.expires === null || c.expires > Date.now()) this.cookies.push(c);
  }
  matching(url) {
    let u;
    try { u = new URL(url); } catch { return []; }
    const host = u.hostname.toLowerCase(), now = Date.now();
    this.cookies = this.cookies.filter((c) => c.expires === null || c.expires > now);
    return this.cookies.filter((c) => (c.hostOnly ? host === c.domain : host === c.domain || host.endsWith('.' + c.domain))
      && (u.pathname === c.path || u.pathname.startsWith(c.path.endsWith('/') ? c.path : c.path + '/') || c.path === '/')
      && (!c.secure || u.protocol === 'https:'));
  }
  header(url) { return this.matching(url).map((c) => `${c.name}=${c.value}`).join('; '); }
  clear() { const n = this.cookies.length; this.cookies = []; return n; }
  get size() { return this.cookies.length; }
}

module.exports = { CookieJar, parseSetCookie };
