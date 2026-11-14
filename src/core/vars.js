'use strict';
// {{...}} placeholders in URLs, headers and bodies. Pure: the caller passes the environment, the file variables, a
// dotenv map and the named responses. Nothing here evaluates code.
//
// Lookup order for {{name}}: file variables (@name = value), then the selected environment, then $shared.
// Built-ins: {{$guid}} {{$uuid}} {{$timestamp [offset unit]}} {{$randomInt min max}} {{$datetime iso8601|rfc1123|"format" [offset unit]}}
//            {{$localDatetime ...}} {{$processEnv [%]NAME}} {{$dotenv [%]NAME}}
// Chained: {{login.response.body.$.token}}, {{login.response.headers.Location}}, {{login.request.body.$.user}}
//          (the body path is JSONPath for JSON bodies; "*" gives the whole body).
const crypto = require('crypto');
const jsonpath = require('./jsonpath');

const RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const MAX_DEPTH = 10;
const UNITS = { y: 'FullYear', M: 'Month', w: 'w', d: 'Date', h: 'Hours', m: 'Minutes', s: 'Seconds', ms: 'Milliseconds' };

function offsetDate(base, amount, unit) {
  const d = new Date(base.getTime());
  const n = Number(amount);
  if (!Number.isFinite(n) || !UNITS[unit]) return d;
  if (unit === 'w') { d.setUTCDate(d.getUTCDate() + 7 * n); return d; }
  const f = UNITS[unit];
  d[`setUTC${f}`](d[`getUTC${f}`]() + n);
  return d;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A small date format: YYYY YY MM M DD D HH H mm ss SSS, local or UTC. */
function formatDate(d, fmt, local) {
  const g = (f) => (local ? d[`get${f}`]() : d[`getUTC${f}`]());
  const map = { YYYY: g('FullYear'), YY: pad(g('FullYear') % 100), MM: pad(g('Month') + 1), M: g('Month') + 1, DD: pad(g('Date')), D: g('Date'), HH: pad(g('Hours')), H: g('Hours'), mm: pad(g('Minutes')), ss: pad(g('Seconds')), SSS: pad(g('Milliseconds'), 3) };
  return fmt.replace(/YYYY|YY|SSS|MM|M|DD|D|HH|H|mm|ss/g, (t) => String(map[t]));
}

function isoLocal(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${formatDate(d, 'YYYY-MM-DDTHH:mm:ss.SSS', true)}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

function datetime(args, local, now) {
  const kind = args[0] || 'iso8601';
  let d = now ? new Date(now) : new Date();
  if (args.length >= 3) d = offsetDate(d, args[1], args[2]);
  if (kind === 'iso8601') return local ? isoLocal(d) : d.toISOString();
  if (kind === 'rfc1123') return local ? `${DAYS[d.getDay()]}, ${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${formatDate(d, 'HH:mm:ss', true)}` : d.toUTCString();
  return formatDate(d, kind, local);
}

function systemVar(name, rest, ctx) {
  const args = splitArgs(rest);
  switch (name) {
    case '$guid': case '$uuid': case '$random.uuid': return crypto.randomUUID();
    case '$timestamp': {
      let d = ctx.now ? new Date(ctx.now) : new Date();
      if (args.length >= 2) d = offsetDate(d, args[0], args[1]);
      return String(Math.floor(d.getTime() / 1000));
    }
    case '$randomInt': {
      const min = Math.ceil(Number(args[0] || 0)), max = Math.floor(Number(args[1] || 1000));
      if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return String(Number.isFinite(min) ? min : 0);
      return String(min + crypto.randomInt(max - min));
    }
    case '$datetime': return datetime(args, false, ctx.now);
    case '$localDatetime': return datetime(args, true, ctx.now);
    case '$processEnv': {
      if (!args[0]) return undefined;
      let key = args[0];
      if (key.startsWith('%')) { const v = lookup(key.slice(1), ctx, 0); if (v === undefined) return undefined; key = v; }
      return Object.prototype.hasOwnProperty.call(ctx.processEnv || {}, key) ? String(ctx.processEnv[key]) : undefined;
    }
    case '$dotenv': {
      if (!args[0]) return undefined;
      let key = args[0];
      if (key.startsWith('%')) { const v = lookup(key.slice(1), ctx, 0); if (v === undefined) return undefined; key = v; }
      return ctx.dotenv && Object.prototype.hasOwnProperty.call(ctx.dotenv, key) ? String(ctx.dotenv[key]) : undefined;
    }
    default: return undefined;
  }
}

function headerValue(headers, name) {
  const n = String(name).toLowerCase();
  for (const [k, v] of headers || []) if (String(k).toLowerCase() === n) return String(v);
  return undefined;
}

/** {{name.response.body.$.x}} and friends. The named result is { request: {headers, body}, response: {headers, body} }. */
function chained(expr, ctx) {
  const m = /^([A-Za-z_][\w-]*)\.(request|response)\.(body|headers)(?:\.(.*))?$/.exec(expr);
  if (!m) return undefined;
  const named = ctx.named && ctx.named[m[1]];
  if (!named) { if (ctx.missingNamed) ctx.missingNamed.add(m[1]); return undefined; }
  const part = named[m[2]];
  if (!part) return undefined;
  const rest = m[4] || '';
  if (m[3] === 'headers') return rest ? headerValue(part.headers, rest) : undefined;
  const body = part.body == null ? '' : String(part.body);
  if (!rest || rest === '*') return body;
  if (rest.startsWith('$')) {
    let data;
    try { data = JSON.parse(body); } catch { return undefined; }
    const hits = jsonpath.query(data, rest);
    if (!hits.ok || !hits.values.length) return undefined;
    const v = hits.values[0];
    return v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return undefined;
}

function lookup(name, ctx, depth) {
  if (ctx.fileVars && Object.prototype.hasOwnProperty.call(ctx.fileVars, name)) {
    const raw = ctx.fileVars[name];
    return resolve(typeof raw === 'object' && raw !== null ? raw.value : raw, ctx, depth + 1);
  }
  for (const scope of [ctx.env, ctx.shared]) {
    if (scope && Object.prototype.hasOwnProperty.call(scope, name)) {
      const v = scope[name];
      return resolve(v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v), ctx, depth + 1);
    }
  }
  return undefined;
}

/**
 * Fills placeholders. ctx: { fileVars, env, shared, dotenv, processEnv, named, now, missing: Set }.
 * Unknown names stay in the text and are added to ctx.missing.
 */
function resolve(text, ctx, depth = 0) {
  if (typeof text !== 'string' || text.indexOf('{{') < 0) return text;
  if (depth > MAX_DEPTH) { if (ctx.missing) ctx.missing.add('(variables refer to each other in a loop)'); return text; }
  return text.replace(RE, (m, inner) => {
    const sp = inner.search(/\s/);
    const name = sp < 0 ? inner : inner.slice(0, sp);
    const rest = sp < 0 ? '' : inner.slice(sp + 1);
    let v;
    if (name.startsWith('$')) v = systemVar(name, rest, ctx);
    else if (name.includes('.')) v = chained(inner.trim(), ctx);
    if (v === undefined && !name.startsWith('$') && !rest) v = lookup(name, ctx, depth);
    if (v === undefined) { if (ctx.missing) ctx.missing.add(inner.trim()); return m; }
    return v;
  });
}

/** Names of the requests this text refers to through {{name.response...}}. */
function referencedNames(text) {
  const out = new Set();
  String(text || '').replace(RE, (m, inner) => { const c = /^([A-Za-z_][\w-]*)\.(request|response)\./.exec(inner.trim()); if (c) out.add(c[1]); return m; });
  return out;
}

/** Parses a .env file into a plain object (KEY=value, export KEY=value, quotes, # comments). */
function parseDotenv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)?\s*$/.exec(line);
    if (!m) continue;
    let v = (m[2] || '').trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2)) v = v.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

/**
 * Environments from the setting and from http-client.env.json style files. Returns { names: [...], get(name) -> {env, shared} }.
 * sources: an array of objects of the form { "$shared": {...}, "dev": {...} }; later sources override earlier ones per key.
 */
function mergeEnvironments(sources) {
  const all = {};
  for (const src of sources) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    for (const [name, vars] of Object.entries(src)) {
      if (!vars || typeof vars !== 'object' || Array.isArray(vars)) continue;
      all[name] = { ...(all[name] || {}), ...vars };
    }
  }
  return {
    names: Object.keys(all).filter((n) => n !== '$shared').sort(),
    get(name) { return { env: (name && all[name]) || {}, shared: all.$shared || {} }; },
    all,
  };
}

module.exports = { resolve, referencedNames, parseDotenv, mergeEnvironments, formatDate, splitArgs, headerValue };
