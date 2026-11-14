'use strict';
// The response as the viewer shows it: kind (json, xml, html, text, image, binary), pretty text, headers, cookies,
// timings. Pure function, so tests can check it without VS Code.
const { headerValue } = require('./vars');

const SHOW_TEXT_MAX = 2 * 1024 * 1024; // bigger bodies show their first 2 MB, the rest is one click away (Open in editor)
const IMAGE_MAX = 10 * 1024 * 1024;

function kindOf(type, buf) {
  const t = String(type || '').toLowerCase();
  if (/[/+]json\b|^application\/(x-)?ndjson/.test(t)) return 'json';
  if (/^image\/(png|jpe?g|gif|webp|bmp|x-icon|vnd\.microsoft\.icon|avif)/.test(t)) return 'image';
  if (/^image\/svg\+xml/.test(t)) return 'xml';
  if (/[/+]xml\b/.test(t)) return 'xml';
  if (/^text\/html/.test(t)) return 'html';
  if (/^text\/|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|csv/.test(t)) return 'text';
  if (!t && buf && buf.length) {
    const head = buf.subarray(0, 2048).toString('utf8').trim();
    if (/^[{[]/.test(head)) { try { JSON.parse(buf.toString('utf8')); return 'json'; } catch { /* not JSON */ } }
    if (/^<\?xml|^<[A-Za-z]/.test(head)) return /^<!doctype html|^<html/i.test(head) ? 'html' : 'xml';
  }
  if (buf && buf.length && isMostlyText(buf)) return 'text';
  return buf && buf.length ? 'binary' : 'text';
}

function isMostlyText(buf) {
  const n = Math.min(buf.length, 4096);
  let bad = 0;
  for (let i = 0; i < n; i++) { const c = buf[i]; if (c === 0) return false; if (c < 9 || (c > 13 && c < 32)) bad++; }
  return bad / Math.max(1, n) < 0.02;
}

function charsetOf(type) { const m = /charset=([^;]+)/i.exec(String(type || '')); return m ? m[1].trim().replace(/"/g, '').toLowerCase() : 'utf-8'; }

function decodeText(buf, type) {
  const cs = charsetOf(type);
  try { return new TextDecoder(cs === 'utf8' ? 'utf-8' : cs, { fatal: false }).decode(buf); } catch { return buf.toString('utf8'); }
}

function prettyXml(s) {
  if (s.length > SHOW_TEXT_MAX) return s;
  const tokens = s.match(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || [];
  const out = [];
  let depth = 0, inline = false, lastOpen = false;
  const pad = () => '  '.repeat(Math.max(0, depth));
  for (const tk of tokens) {
    if (tk.startsWith('</')) {
      depth--;
      if (inline || lastOpen) out[out.length - 1] += tk; else out.push(pad() + tk);
      inline = false; lastOpen = false;
    } else if (/^<[?!]/.test(tk) || tk.endsWith('/>')) { out.push(pad() + tk); inline = false; lastOpen = false; }
    else if (tk.startsWith('<')) { out.push(pad() + tk); depth++; inline = false; lastOpen = true; }
    else {
      const t = tk.trim();
      if (!t) continue;
      if (lastOpen) { out[out.length - 1] += t; inline = true; } else out.push(pad() + t);
      lastOpen = false;
    }
  }
  return out.join('\n');
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 2 : 1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

function parseCookies(headers) {
  return headers.filter(([k]) => k.toLowerCase() === 'set-cookie').map(([, v]) => {
    const parts = String(v).split(';').map((p) => p.trim());
    const [nv, ...attrs] = parts;
    const eq = nv.indexOf('=');
    return { name: eq > 0 ? nv.slice(0, eq) : nv, value: eq > 0 ? nv.slice(eq + 1) : '', attributes: attrs.join('; ') };
  });
}

/** res: the result of send(). Returns a plain object for the webview. */
function viewModel(res, { label = '', showMax = SHOW_TEXT_MAX } = {}) {
  const type = headerValue(res.headers, 'content-type') || '';
  const kind = kindOf(type, res.body);
  const vm = {
    label, status: res.status, statusText: res.statusText, httpVersion: res.httpVersion, url: res.url, redirects: res.redirects || [],
    type, kind, size: res.body.length, sizeText: formatSize(res.body.length), wireBytes: res.bodyBytes, truncatedDownload: !!res.truncated,
    time: Math.round(res.timings.total), timings: Object.fromEntries(Object.entries(res.timings).filter(([k]) => k !== 'start').map(([k, v]) => [k, Math.round(v * 10) / 10])),
    headers: res.headers, cookies: parseCookies(res.headers), request: res.request ? { method: res.request.method, url: res.request.url, headers: res.request.headers, body: res.request.body == null ? '' : String(res.request.body).slice(0, 200000) } : null,
    text: '', pretty: '', json: null, image: null, cut: false,
  };
  if (kind === 'image') {
    if (res.body.length <= IMAGE_MAX) vm.image = `data:${type.split(';')[0].trim()};base64,${res.body.toString('base64')}`;
    return vm;
  }
  if (kind === 'binary') { vm.text = `${formatSize(res.body.length)} of binary data (${type || 'no Content-Type'}). Save the body to a file to open it.`; return vm; }
  let text = decodeText(res.body.length > showMax ? res.body.subarray(0, showMax) : res.body, type);
  vm.cut = res.body.length > showMax;
  vm.text = text;
  if (kind === 'json' && !vm.cut) {
    try { const data = JSON.parse(text); vm.json = data; vm.pretty = JSON.stringify(data, null, 2); }
    catch {
      // NDJSON: one value per line
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      try { const vals = lines.map((l) => JSON.parse(l)); vm.json = vals; vm.pretty = vals.map((v) => JSON.stringify(v)).join('\n'); } catch { vm.pretty = text; }
    }
  } else if (kind === 'xml' || kind === 'html') vm.pretty = kind === 'xml' ? prettyXml(text) : text;
  else vm.pretty = text;
  return vm;
}

/** The whole exchange as raw HTTP text, for "Open in editor". */
function rawText(res) {
  const lines = [`HTTP/${res.httpVersion || '1.1'} ${res.status} ${res.statusText || ''}`.trimEnd()];
  for (const [k, v] of res.headers) lines.push(`${k}: ${v}`);
  const type = headerValue(res.headers, 'content-type') || '';
  const kind = kindOf(type, res.body);
  let body = '';
  if (kind === 'binary' || kind === 'image') body = `(${formatSize(res.body.length)} of ${kind} data)`;
  else {
    body = decodeText(res.body, type);
    if (kind === 'json') { try { body = JSON.stringify(JSON.parse(body), null, 2); } catch { /* keep */ } }
  }
  return lines.join('\n') + '\n\n' + body;
}

function languageFor(kind, type) {
  if (kind === 'json') return 'json';
  if (kind === 'xml') return 'xml';
  if (kind === 'html') return 'html';
  if (/javascript/.test(type)) return 'javascript';
  if (/css/.test(type)) return 'css';
  if (/yaml/.test(type)) return 'yaml';
  if (/csv/.test(type)) return 'csv';
  return 'plaintext';
}

function extensionFor(kind, type) {
  const t = String(type).toLowerCase();
  const m = /^image\/(png|jpeg|gif|webp|bmp|avif)/.exec(t);
  if (m) return m[1] === 'jpeg' ? 'jpg' : m[1];
  if (kind === 'json') return 'json';
  if (kind === 'xml') return /svg/.test(t) ? 'svg' : 'xml';
  if (kind === 'html') return 'html';
  if (/pdf/.test(t)) return 'pdf';
  if (/zip/.test(t)) return 'zip';
  if (/csv/.test(t)) return 'csv';
  if (kind === 'text') return 'txt';
  return 'bin';
}

module.exports = { viewModel, rawText, kindOf, formatSize, languageFor, extensionFor, prettyXml, parseCookies, decodeText };
