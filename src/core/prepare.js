'use strict';
// Turns a parsed request into what goes on the wire: variables filled, body file read, GraphQL wrapped as JSON,
// form bodies joined, Basic auth "user pass" encoded. readFile is passed in (async (path) => Buffer) so tests and the
// extension can each supply their own.
const { resolve, headerValue } = require('./vars');

function setHeader(headers, name, value) {
  const n = name.toLowerCase();
  const i = headers.findIndex(([k]) => k.toLowerCase() === n);
  if (i >= 0) headers[i] = [headers[i][0], value]; else headers.push([name, value]);
}

/** Authorization: Basic user pass (or user:pass) becomes base64; Digest stays as written. */
function basicAuth(value) {
  const m = /^\s*basic\s+(.+)$/i.exec(value);
  if (!m) return value;
  const rest = m[1].trim();
  if (/^[A-Za-z0-9+/]+=*$/.test(rest) && !rest.includes(':') && rest.length % 4 === 0) return value; // already base64
  const sp = rest.indexOf(' ');
  const pair = rest.includes(':') && (sp < 0 || rest.indexOf(':') < sp) ? rest : sp > 0 ? `${rest.slice(0, sp)}:${rest.slice(sp + 1)}` : rest;
  return `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
}

/** GraphQL: X-Request-Type: GraphQL, the query, an empty line, then the variables as JSON. */
function graphqlBody(text) {
  const parts = String(text).split(/\r?\n\s*\r?\n/);
  let query = parts[0];
  let variables;
  if (parts.length > 1) {
    const rest = parts.slice(1).join('\n\n').trim();
    if (rest) {
      try { variables = JSON.parse(rest); } catch { query = String(text); }
    }
  }
  const op = /^\s*(query|mutation|subscription)\s+([A-Za-z_]\w*)/m.exec(query);
  const out = { query: query.trim() };
  if (op) out.operationName = op[2];
  if (variables !== undefined) out.variables = variables;
  return JSON.stringify(out);
}

/**
 * req: a parsed request. ctx: the variable context (see vars.resolve). readFile: async (relPath, withVars) => string|Buffer.
 * Returns { method, url, headers, body (string or Buffer or null), missing: [names], name, notes }.
 */
async function prepare(req, ctx, { readFile } = {}) {
  const missing = new Set();
  const c = { ...ctx, missing };
  const url = resolve(req.url, c).replace(/\s+/g, (s) => (s.includes('\n') ? '' : encodeURIComponent(s)));
  const headers = req.headers.map(([k, v]) => [resolve(k, c), resolve(v, c)]);
  const notes = [...(req.notes || [])];
  let body = null;
  if (req.bodyFile) {
    if (!readFile) throw new Error('This request reads its body from a file, which is not possible here.');
    const raw = await readFile(resolve(req.bodyFile.path, c));
    body = req.bodyFile.vars ? resolve(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw), c) : raw;
  } else if (req.body != null) {
    body = resolve(req.body, c);
  }
  const type = (headerValue(headers, 'content-type') || '').toLowerCase();
  const isGraphql = /^graphql$/i.test(headerValue(headers, 'x-request-type') || '');
  if (isGraphql) {
    for (let i = headers.length - 1; i >= 0; i--) if (headers[i][0].toLowerCase() === 'x-request-type') headers.splice(i, 1);
    if (typeof body === 'string') body = graphqlBody(body);
    if (!type) setHeader(headers, 'Content-Type', 'application/json');
  } else if (typeof body === 'string' && type.startsWith('application/x-www-form-urlencoded') && body.includes('\n')) {
    body = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('');
  } else if (typeof body === 'string') {
    body = body.replace(/\r?\n/g, '\r\n').replace(/\r\r\n/g, '\r\n');
    if (!type.startsWith('multipart/')) body = body.replace(/\r\n/g, '\n');
  }
  for (let i = 0; i < headers.length; i++) if (headers[i][0].toLowerCase() === 'authorization') headers[i] = [headers[i][0], basicAuth(headers[i][1])];
  return { method: req.method, url, headers, body, missing: [...missing], name: req.name, notes, noRedirect: req.noRedirect, noCookieJar: req.noCookieJar, timeoutMs: req.timeoutMs };
}

module.exports = { prepare, basicAuth, graphqlBody, setHeader };
