'use strict';
// cURL in both directions: paste a cURL command as a .http request (free) and copy a request as cURL (free).
// shellWords and fromCurl come from our Load Testing extension (factory/products/load-testing-vscode, same author).

// ---------------------------------------------------------------------------------------------- cURL
const HOP = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te']);

function cleanHeaders(list) {
  const out = [];
  const seen = new Set();
  for (const [k, v] of list) {
    const n = String(k).trim();
    if (!n || n.startsWith(':') || HOP.has(n.toLowerCase())) continue;
    const key = n.toLowerCase();
    if (seen.has(key) && key !== 'cookie') continue;
    seen.add(key);
    out.push([n, String(v)]);
  }
  return out;
}

function shellWords(cmd) {
  const s = String(cmd || '').replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ').replace(/`\r?\n/g, ' ');
  const out = [];
  let cur = '', inWord = false, i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { if (inWord) { out.push(cur); cur = ''; inWord = false; } i++; continue; }
    inWord = true;
    if (c === "'") { const j = s.indexOf("'", i + 1); if (j < 0) throw new Error('A single quote is not closed.'); cur += s.slice(i + 1, j); i = j + 1; continue; }
    if (c === '$' && s[i + 1] === "'") {
      let j = i + 2;
      for (; j < s.length && s[j] !== "'"; j++) {
        if (s[j] === '\\' && j + 1 < s.length) {
          const n = s[++j];
          cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
        } else cur += s[j];
      }
      if (j >= s.length) throw new Error('A $\'...\' string is not closed.');
      i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '\\' && '"\\$`'.includes(s[j + 1])) { cur += s[++j]; } else cur += s[j];
      }
      if (j >= s.length) throw new Error('A double quote is not closed.');
      i = j + 1; continue;
    }
    if (c === '\\' && i + 1 < s.length) { cur += s[i + 1]; i += 2; continue; }
    cur += c; i++;
  }
  if (inWord) out.push(cur);
  return out;
}
function fromCurl(cmd) {
  const notes = [];
  let words;
  try { words = shellWords(String(cmd || '').trim()); } catch (e) { return { requests: [], variables: {}, notes: [e.message] }; }
  const ci = words.findIndex((w) => /(^|[\\/])curl(\.exe)?$/i.test(w));
  if (ci < 0) return { requests: [], variables: {}, notes: ['This text does not start with curl.'] };
  words = words.slice(ci + 1);
  let method = '', url = '', get = false, insecure = false;
  const headers = [], data = [];
  let json = false;
  const takes = new Set(['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json',
    '-u', '--user', '-A', '--user-agent', '-b', '--cookie', '-e', '--referer', '--url', '-o', '--output', '-m', '--max-time', '--connect-timeout',
    '-x', '--proxy', '-w', '--write-out', '--retry', '-T', '--upload-file', '-F', '--form', '--cacert', '--cert', '--key', '-r', '--range', '--resolve', '-c', '--cookie-jar']);
  for (let i = 0; i < words.length; i++) {
    let w = words[i];
    let val;
    const eq = /^(--[a-z-]+)=(.*)$/s.exec(w);
    if (eq && takes.has(eq[1])) { w = eq[1]; val = eq[2]; }
    else if (/^-[XHdAbeuo]./.test(w) && !w.startsWith('--')) { val = w.slice(2); w = w.slice(0, 2); }
    else if (takes.has(w)) { val = words[++i]; }
    switch (w) {
      case '-X': case '--request': method = String(val || '').toUpperCase(); break;
      case '-H': case '--header': { const m = /^([^:]+):\s*(.*)$/s.exec(val || ''); if (m) headers.push([m[1].trim(), m[2]]); break; }
      case '-d': case '--data': case '--data-ascii': case '--data-binary': case '--data-raw':
        if (String(val).startsWith('@') && w !== '--data-raw') notes.push(`The body is read from the file ${val.slice(1)}. It is written as a body file line (< ./file).`);
        data.push(String(val == null ? '' : val)); break;
      case '--data-urlencode': {
        const v = String(val || ''); const k = v.indexOf('=');
        data.push(k > 0 ? v.slice(0, k + 1) + encodeURIComponent(v.slice(k + 1)) : encodeURIComponent(v.replace(/^=/, ''))); break;
      }
      case '--json': json = true; data.push(String(val || '')); break;
      case '-u': case '--user': headers.push(['authorization', 'Basic ' + Buffer.from(String(val || '')).toString('base64')]); break;
      case '-A': case '--user-agent': headers.push(['user-agent', String(val || '')]); break;
      case '-b': case '--cookie': if (String(val).includes('=')) headers.push(['cookie', String(val)]); else notes.push('Cookies from a file are not imported.'); break;
      case '-e': case '--referer': headers.push(['referer', String(val || '')]); break;
      case '--url': url = String(val || ''); break;
      case '-G': case '--get': get = true; break;
      case '-I': case '--head': method = 'HEAD'; break;
      case '-k': case '--insecure': insecure = true; break;
      case '-F': case '--form': notes.push('Multipart form fields (-F) are not converted. Write them as a multipart body.'); break;
      case '-T': case '--upload-file': notes.push('File uploads (-T) are not imported.'); break;
      default:
        if (val === undefined && !w.startsWith('-') && !url) url = w;
    }
  }
  if (!url) return { requests: [], variables: {}, notes: notes.concat('No URL found in the cURL command.') };
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  let body = data.length ? data.join('&') : null;
  if (get && body != null) { url += (url.includes('?') ? '&' : '?') + body; body = null; }
  if (!method) method = body != null ? 'POST' : 'GET';
  const has = (n) => headers.some(([k]) => k.toLowerCase() === n);
  if (json) { if (!has('content-type')) headers.push(['content-type', 'application/json']); if (!has('accept')) headers.push(['accept', 'application/json']); }
  else if (body != null && !has('content-type')) headers.push(['content-type', 'application/x-www-form-urlencoded']);
  const short = (() => { try { const u = new URL(url); return u.pathname; } catch (e) { return url; } })();
  return { requests: [{ name: `${method} ${short}`, method, url, headers: cleanHeaders(headers), body }], variables: {}, notes, insecure };
}

function shellQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

/** A request as one cURL command (POSIX shell quoting). req: { method, url, headers: [[k, v]], body }. */
function toCurl(req, { multiline = true } = {}) {
  const parts = ['curl'];
  const method = String(req.method || 'GET').toUpperCase();
  const hasBody = req.body != null && req.body !== '';
  if (method === 'HEAD') parts.push('--head');
  else if (!(method === 'GET' && !hasBody) && !(method === 'POST' && hasBody)) parts.push('-X', method);
  parts.push(shellQuote(req.url));
  for (const [k, v] of req.headers || []) {
    if (/^(user-agent|accept-encoding)$/i.test(k) && /zovo-rest-client|gzip, deflate, br/.test(v)) continue;
    parts.push('-H', shellQuote(`${k}: ${v}`));
  }
  if (hasBody) parts.push('--data-raw', shellQuote(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body));
  if (!multiline) return parts.join(' ');
  // One option per line for readability.
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith('-') && i + 1 < parts.length && !parts[i + 1].startsWith('-') && parts[i] !== '--head') { out.push(`${parts[i]} ${parts[i + 1]}`); i++; } else out.push(parts[i]);
  }
  return out.join(' \\\n  ');
}

module.exports = { shellWords, fromCurl, toCurl, shellQuote, cleanHeaders };
