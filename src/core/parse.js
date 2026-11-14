'use strict';
// Parser for .http and .rest files. Pure function: no VS Code, no file system, no network.
//
//   @host = https://api.example.com          file variable (anywhere outside a request body)
//   ### Get one user                          ### starts a new request; the text after it is a title
//   # @name getUser                           a name other requests use: {{getUser.response.body.$.id}}
//   # @assert status == 200                   assertions for "Run all requests" (Zovo Pro)
//   GET {{host}}/users/1 HTTP/1.1             request line: method (GET when left out), URL, optional version
//       ?expand=roles                         query lines that start with ? or & join the URL
//   Accept: application/json                  headers until the first empty line
//
//   {"body": "after the empty line"}          body; "< ./file.json" reads a file, "<@ ./file.json" also fills variables
//
// Every request keeps its line numbers, so the editor can put a "Send Request" link over it.

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK', 'QUERY'];
const METHOD_RE = new RegExp(`^(${METHODS.join('|')})\\s+(\\S.*)$`, 'i');
const VERSION_RE = /\s+(HTTP\/[0-9.]+)\s*$/i;
const FILE_VAR_RE = /^\s*@([A-Za-z_][\w.-]*)\s*=\s?(.*)$/;
const META_RE = /^\s*(?:#|\/\/)\s*@([A-Za-z][\w-]*)\s*(.*)$/;
const COMMENT_RE = /^\s*(?:#|\/\/)/;
const SEPARATOR_RE = /^\s*###/;
const HEADER_RE = /^([^\s:][^:]*?)\s*:\s?(.*)$/;

function isUrlStart(s) {
  return /^(https?:\/\/|\/|\{\{|[A-Za-z0-9.-]+(:\d+)?(\/|$)|localhost)/i.test(s);
}

/** Splits the file into blocks at ### lines. Returns [{ start, end, title }] with 0-based inclusive line numbers. */
function blocks(lines) {
  const out = [];
  let start = 0, title = '';
  for (let i = 0; i < lines.length; i++) {
    if (SEPARATOR_RE.test(lines[i])) {
      if (i > start || out.length === 0) out.push({ start, end: i - 1, title });
      start = i + 1;
      title = lines[i].replace(/^\s*###+\s*/, '').trim();
    }
  }
  out.push({ start, end: lines.length - 1, title });
  return out.filter((b) => b.end >= b.start);
}

function parseBlock(lines, b, fileVars) {
  const meta = { name: '', title: b.title, asserts: [], noRedirect: false, noCookieJar: false, timeoutMs: 0, notes: [] };
  let i = b.start;
  // Leading part: comments, metadata and file variables.
  for (; i <= b.end; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const fv = FILE_VAR_RE.exec(line);
    if (fv) { fileVars[fv[1]] = { value: fv[2].trim(), line: i }; continue; }
    const m = META_RE.exec(line);
    if (m) {
      const key = m[1].toLowerCase(), val = m[2].trim();
      if (key === 'name') meta.name = val.split(/\s+/)[0] || '';
      else if (key === 'assert') { if (val) meta.asserts.push({ text: val, line: i }); }
      else if (key === 'no-redirect') meta.noRedirect = true;
      else if (key === 'no-cookie-jar') meta.noCookieJar = true;
      else if (key === 'timeout') { const n = Number(val.replace(/ms$/i, '')); if (Number.isFinite(n) && n > 0) meta.timeoutMs = n; }
      continue;
    }
    if (COMMENT_RE.test(line)) continue;
    break;
  }
  if (i > b.end) return null; // only variables or comments in this block
  const reqLine = i;
  let text = lines[i].trim();
  let method = 'GET', url;
  const mm = METHOD_RE.exec(text);
  if (mm) { method = mm[1].toUpperCase(); url = mm[2]; }
  else if (isUrlStart(text)) url = text;
  else return { error: `Line ${i + 1} is not a request line. Start it with a method and a URL, for example GET https://example.com`, line: i, start: b.start, end: b.end };
  let httpVersion = '';
  const vm = VERSION_RE.exec(url);
  if (vm) { httpVersion = vm[1].toUpperCase(); url = url.slice(0, vm.index); }
  url = url.trim();
  i++;
  // Query continuation lines.
  for (; i <= b.end; i++) {
    const t = lines[i].trim();
    if (/^[?&]/.test(t)) url += t;
    else break;
  }
  // Headers.
  const headers = [];
  for (; i <= b.end; i++) {
    const line = lines[i];
    if (!line.trim()) { i++; break; }
    if (COMMENT_RE.test(line)) { const m = META_RE.exec(line); if (m && m[1].toLowerCase() === 'assert' && m[2].trim()) meta.asserts.push({ text: m[2].trim(), line: i }); continue; }
    const h = HEADER_RE.exec(line.trim());
    if (h) headers.push([h[1].trim(), h[2]]);
    else meta.notes.push(`Line ${i + 1} is not a header (Name: value). It was skipped.`);
  }
  // Body: everything up to the end of the block, without trailing empty lines and response-handler scripts.
  let bodyLines = lines.slice(i, b.end + 1);
  let end = bodyLines.length;
  while (end > 0 && !bodyLines[end - 1].trim()) end--;
  bodyLines = bodyLines.slice(0, end);
  // A response handler (> {% ... %} or > ./script.js) and response reference (<> ./file) are not run: drop them.
  const cut = bodyLines.findIndex((l) => /^\s*(>\s*(\{%|\S+\.js\s*$)|<>\s)/.test(l));
  if (cut >= 0) { meta.notes.push('Response handler scripts (> {% ... %}) are not run. Use # @assert lines instead.'); bodyLines = bodyLines.slice(0, cut); while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) bodyLines.pop(); }
  let body = null, bodyFile = null;
  if (bodyLines.length) {
    const first = bodyLines[0].trim();
    const fm = /^<(@)?\s+(.+)$/.exec(first);
    if (bodyLines.length === 1 && fm) bodyFile = { path: fm[2].trim(), vars: !!fm[1] };
    else body = bodyLines.join('\n');
  }
  return {
    name: meta.name, title: meta.title, method, url, httpVersion, headers, body, bodyFile,
    asserts: meta.asserts, noRedirect: meta.noRedirect, noCookieJar: meta.noCookieJar, timeoutMs: meta.timeoutMs, notes: meta.notes,
    start: b.start, end: b.end, line: reqLine,
  };
}

/** Parses the whole file. Returns { requests, errors, fileVars: { name: { value, line } } }. */
function parseHttp(text) {
  const lines = String(text == null ? '' : text).replace(/^﻿/, '').split(/\r?\n/);
  const fileVars = {};
  const requests = [], errors = [];
  for (const b of blocks(lines)) {
    const r = parseBlock(lines, b, fileVars);
    if (!r) continue;
    if (r.error) errors.push(r); else requests.push(r);
  }
  return { requests, errors, fileVars };
}

/** The request whose block holds the given 0-based line, or null. */
function requestAt(parsed, line) {
  return parsed.requests.find((r) => line >= r.start && line <= r.end) || null;
}

/** A display label: the @name, the ### title, or METHOD + path. */
function labelOf(r) {
  if (r.name) return r.name;
  if (r.title) return r.title;
  return `${r.method} ${r.url}`;
}

/** Writes requests back as .http text (used by the importers, cURL paste and history). */
function toHttpText(reqs, { variables } = {}) {
  const out = [];
  if (variables) for (const [k, v] of Object.entries(variables)) out.push(`@${k} = ${v}`);
  if (out.length) out.push('');
  reqs.forEach((r) => {
    out.push(`### ${r.title || r.label || r.name || `${r.method} ${r.url}`}`.trimEnd());
    if (r.comment) for (const c of String(r.comment).split(/\r?\n/)) if (c.trim()) out.push(`# ${c.trim()}`);
    if (r.name && /^[A-Za-z_][\w-]*$/.test(r.name)) out.push(`# @name ${r.name}`);
    for (const a of r.asserts || []) out.push(`# @assert ${typeof a === 'string' ? a : a.text}`);
    out.push(`${r.method || 'GET'} ${r.url}`);
    for (const [k, v] of r.headers || []) out.push(`${k}: ${v}`);
    if (r.body != null && r.body !== '') { out.push(''); out.push(String(r.body)); }
    out.push('');
  });
  return out.join('\n');
}

module.exports = { parseHttp, requestAt, labelOf, toHttpText, METHODS, blocks };
