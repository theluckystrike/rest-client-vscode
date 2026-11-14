'use strict';
// Zovo Pro: "Import a collection". Postman (v2.0 and v2.1 collections and environments), Insomnia (export v4 JSON
// or YAML) and OpenAPI 3 / Swagger 2 (JSON or YAML) become one .http file plus an environment object for
// http-client.env.json. Pure functions: no VS Code, no network. The OpenAPI part comes from our Load Testing extension.
const YAML = require('../../vendor/yaml');
const { toHttpText } = require('./parse');

function arr(v) { return Array.isArray(v) ? v : []; }
function str(v) { return v == null ? '' : String(v); }
// Postman and Insomnia write {{var}} too; Insomnia also writes {{ _.var }}.
function vars(s) { return str(s).replace(/\{\{\s*_\.([\w.-]+)\s*\}\}/g, '{{$1}}').replace(/\{\{\s*\$guid\s*\}\}/g, '{{$guid}}').replace(/\{\{\s*\$timestamp\s*\}\}/g, '{{$timestamp}}').replace(/\{\{\s*\$randomInt\s*\}\}/g, '{{$randomInt 0 1000}}'); }
function safeName(s) { const n = str(s).replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, '_$1'); return n.slice(0, 60); }

// ---------------------------------------------------------------------------------------------- Postman
function postmanUrl(u) {
  if (typeof u === 'string') return u;
  if (!u || typeof u !== 'object') return '';
  if (u.raw) return u.raw;
  const host = Array.isArray(u.host) ? u.host.join('.') : str(u.host);
  const path = Array.isArray(u.path) ? '/' + u.path.join('/') : str(u.path);
  const q = arr(u.query).filter((x) => x && !x.disabled).map((x) => `${x.key}=${x.value == null ? '' : x.value}`).join('&');
  return `${u.protocol ? u.protocol + '://' : ''}${host}${u.port ? ':' + u.port : ''}${path}${q ? '?' + q : ''}`;
}

function authValue(list, key) {
  if (Array.isArray(list)) { const f = list.find((x) => x && x.key === key); return f ? str(f.value) : ''; }
  if (list && typeof list === 'object') return str(list[key]);
  return '';
}

function postmanAuth(auth, headers, notes, where) {
  if (!auth || !auth.type || auth.type === 'noauth') return;
  const a = auth[auth.type];
  if (auth.type === 'bearer') headers.push(['Authorization', `Bearer ${vars(authValue(a, 'token'))}`]);
  else if (auth.type === 'basic') headers.push(['Authorization', `Basic ${vars(authValue(a, 'username'))} ${vars(authValue(a, 'password'))}`]);
  else if (auth.type === 'apikey') {
    const k = authValue(a, 'key') || 'X-API-Key', v = vars(authValue(a, 'value'));
    if ((authValue(a, 'in') || 'header') === 'header') headers.push([k, v]); else return { query: `${k}=${v}` };
  } else notes.push(`${where}: "${auth.type}" authorization is not converted. Add the header by hand.`);
  return undefined;
}

function postmanBody(body, headers, notes, where) {
  if (!body || body.disabled) return null;
  const has = (n) => headers.some(([k]) => k.toLowerCase() === n);
  switch (body.mode) {
    case 'raw': {
      const lang = body.options && body.options.raw && body.options.raw.language;
      if (lang === 'json' && !has('content-type')) headers.push(['Content-Type', 'application/json']);
      if (lang === 'xml' && !has('content-type')) headers.push(['Content-Type', 'application/xml']);
      return vars(body.raw);
    }
    case 'urlencoded':
      if (!has('content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
      return arr(body.urlencoded).filter((x) => x && !x.disabled).map((x) => `${encodeURIComponent(str(x.key))}=${vars(str(x.value))}`).join('\n&');
    case 'graphql':
      headers.push(['X-Request-Type', 'GraphQL']);
      if (!has('content-type')) headers.push(['Content-Type', 'application/json']);
      return `${str(body.graphql && body.graphql.query).trim()}${body.graphql && body.graphql.variables && str(body.graphql.variables).trim() ? '\n\n' + str(body.graphql.variables).trim() : ''}`;
    case 'formdata': {
      const boundary = 'ZovoFormBoundary';
      headers.push(['Content-Type', `multipart/form-data; boundary=${boundary}`]);
      const parts = [];
      for (const f of arr(body.formdata).filter((x) => x && !x.disabled)) {
        if (f.type === 'file') { parts.push(`--${boundary}\nContent-Disposition: form-data; name="${f.key}"; filename="${str(f.src).split(/[\\/]/).pop()}"\n\n< ${str(f.src)}`); notes.push(`${where}: the file field "${f.key}" needs its file; check the path.`); }
        else parts.push(`--${boundary}\nContent-Disposition: form-data; name="${f.key}"\n\n${vars(f.value)}`);
      }
      return parts.length ? parts.join('\n') + `\n--${boundary}--` : null;
    }
    case 'file': notes.push(`${where}: a binary file body is written as a "< path" line.`); return `< ${str(body.file && body.file.src)}`;
    default: return null;
  }
}

function fromPostman(doc) {
  const notes = [], requests = [], variables = {};
  for (const v of arr(doc.variable)) if (v && v.key && !v.disabled) variables[v.key] = vars(v.value);
  const walk = (items, folder, inheritedAuth) => {
    for (const it of arr(items)) {
      if (!it) continue;
      const name = folder ? `${folder} / ${str(it.name)}` : str(it.name);
      if (Array.isArray(it.item)) { walk(it.item, name, it.auth || inheritedAuth); continue; }
      const r = it.request;
      if (!r) continue;
      const req = typeof r === 'string' ? { url: r, method: 'GET' } : r;
      const headers = arr(req.header).filter((h) => h && !h.disabled && h.key).map((h) => [str(h.key), vars(h.value)]);
      let url = vars(postmanUrl(req.url));
      const q = postmanAuth(req.auth || inheritedAuth || doc.auth, headers, notes, name);
      if (q && q.query) url += (url.includes('?') ? '&' : '?') + q.query;
      const body = postmanBody(req.body, headers, notes, name);
      if (arr(it.event).some((e) => e && e.script && arr(e.script.exec).join('').trim())) notes.push(`${name}: its pre-request or test script is not converted.`);
      requests.push({ title: name, name: safeName(it.name), method: str(req.method || 'GET').toUpperCase(), url, headers, body, comment: typeof req.description === 'string' ? req.description.split('\n')[0] : '' });
    }
  };
  walk(doc.item, '', null);
  return { requests, variables, notes, title: str(doc.info && doc.info.name) };
}

function fromPostmanEnvironment(doc) {
  const env = {};
  for (const v of arr(doc.values)) if (v && v.key && v.enabled !== false) env[v.key] = str(v.value);
  return { name: str(doc.name) || 'imported', env };
}

// ---------------------------------------------------------------------------------------------- Insomnia
function fromInsomnia(doc) {
  const notes = [], requests = [], variables = {};
  const res = arr(doc.resources);
  const byId = new Map(res.map((r) => [r._id, r]));
  const path = (r) => { const out = []; let p = byId.get(r.parentId); let n = 0; while (p && p._type === 'request_group' && n++ < 20) { out.unshift(p.name); p = byId.get(p.parentId); } return out.join(' / '); };
  const environments = {};
  for (const r of res) {
    if (r._type === 'environment' && r.data && typeof r.data === 'object') {
      const parent = byId.get(r.parentId);
      if (parent && parent._type === 'workspace') Object.assign(variables, Object.fromEntries(Object.entries(r.data).filter(([, v]) => typeof v !== 'object').map(([k, v]) => [k, str(v)])));
      else environments[r.name || 'imported'] = Object.fromEntries(Object.entries(r.data).filter(([, v]) => typeof v !== 'object').map(([k, v]) => [k, str(v)]));
    }
  }
  for (const r of res.filter((x) => x._type === 'request')) {
    const folder = path(r);
    const name = folder ? `${folder} / ${r.name}` : str(r.name);
    const headers = arr(r.headers).filter((h) => h && !h.disabled && h.name).map((h) => [str(h.name), vars(h.value)]);
    let url = vars(r.url);
    const q = arr(r.parameters).filter((p) => p && !p.disabled && p.name).map((p) => `${p.name}=${vars(p.value)}`).join('&');
    if (q) url += (url.includes('?') ? '&' : '?') + q;
    const a = r.authentication || {};
    if (a.type === 'bearer' && !a.disabled) headers.push(['Authorization', `${a.prefix || 'Bearer'} ${vars(a.token)}`]);
    else if (a.type === 'basic' && !a.disabled) headers.push(['Authorization', `Basic ${vars(a.username)} ${vars(a.password)}`]);
    else if (a.type && a.type !== 'none' && !a.disabled) notes.push(`${name}: "${a.type}" authorization is not converted.`);
    let body = null;
    const b = r.body || {};
    if (typeof b.text === 'string' && b.text) {
      body = vars(b.text);
      if (b.mimeType && !headers.some(([k]) => k.toLowerCase() === 'content-type')) headers.push(['Content-Type', b.mimeType]);
      if (b.mimeType === 'application/graphql') { headers.push(['X-Request-Type', 'GraphQL']); try { const g = JSON.parse(b.text); body = `${g.query || ''}${g.variables ? '\n\n' + JSON.stringify(g.variables, null, 2) : ''}`; } catch { /* keep text */ } }
    } else if (Array.isArray(b.params) && b.mimeType === 'application/x-www-form-urlencoded') {
      if (!headers.some(([k]) => k.toLowerCase() === 'content-type')) headers.push(['Content-Type', b.mimeType]);
      body = b.params.filter((p) => !p.disabled).map((p) => `${encodeURIComponent(p.name)}=${vars(p.value)}`).join('\n&');
    } else if (Array.isArray(b.params) && b.params.length) notes.push(`${name}: a multipart body is not converted.`);
    requests.push({ title: name, name: safeName(r.name), method: str(r.method || 'GET').toUpperCase(), url, headers, body, comment: r.description ? str(r.description).split('\n')[0] : '' });
  }
  return { requests, variables, notes, environments, title: str((res.find((x) => x._type === 'workspace') || {}).name) };
}

function resolveRef(doc, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let cur = doc;
  for (const part of ref.slice(2).split('/')) {
    const k = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!cur || typeof cur !== 'object' || !(k in cur)) return null;
    cur = cur[k];
  }
  return cur;
}

function deref(doc, v, seen = new Set()) {
  let n = 0;
  while (v && typeof v === 'object' && typeof v.$ref === 'string' && n++ < 20) {
    if (seen.has(v.$ref)) return {};
    seen.add(v.$ref);
    v = resolveRef(doc, v.$ref);
  }
  return v || {};
}

function sampleOf(doc, schema, depth = 0, seen = new Set()) {
  const s = deref(doc, schema, new Set(seen));
  if (depth > 5) return null;
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (s.allOf) return Object.assign({}, ...s.allOf.map((x) => sampleOf(doc, x, depth + 1, seen)).filter((x) => x && typeof x === 'object'));
  if (s.oneOf || s.anyOf) return sampleOf(doc, (s.oneOf || s.anyOf)[0], depth + 1, seen);
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  if (type === 'object' || s.properties) {
    const o = {};
    for (const [k, v] of Object.entries(s.properties || {})) {
      const vv = deref(doc, v);
      if (vv.readOnly) continue;
      o[k] = sampleOf(doc, v, depth + 1, seen);
    }
    return o;
  }
  if (type === 'array') return [sampleOf(doc, s.items || {}, depth + 1, seen)];
  if (type === 'integer' || type === 'number') return s.minimum !== undefined ? s.minimum : 1;
  if (type === 'boolean') return true;
  if (type === 'string') {
    if (s.format === 'date-time') return '2026-01-01T00:00:00Z';
    if (s.format === 'date') return '2026-01-01';
    if (s.format === 'email') return 'user@example.com';
    if (s.format === 'uuid') return '00000000-0000-4000-8000-000000000000';
    return 'string';
  }
  return null;
}

function fromOpenApi(text) {
  const notes = [];
  let doc;
  try {
    doc = YAML.parse(String(text || '').replace(/^﻿/, ''), { maxAliasCount: 100, uniqueKeys: false });
  } catch (e) { return { requests: [], variables: {}, notes: [`The file could not be read: ${String(e.message).split('\n')[0]}`] }; }
  if (!doc || typeof doc !== 'object' || !(doc.openapi || doc.swagger)) return { requests: [], variables: {}, notes: ['This is not an OpenAPI or Swagger document (no "openapi" or "swagger" key).'] };
  let base = '';
  if (doc.openapi) {
    const sv = Array.isArray(doc.servers) && doc.servers[0];
    if (sv && sv.url) {
      base = String(sv.url).replace(/\{([^}]+)\}/g, (m, k) => (sv.variables && sv.variables[k] && sv.variables[k].default) || m);
    }
  } else {
    const scheme = (Array.isArray(doc.schemes) && doc.schemes[0]) || 'https';
    if (doc.host) base = `${scheme}://${doc.host}${doc.basePath || ''}`;
    else if (doc.basePath) base = doc.basePath;
  }
  if (!/^https?:\/\//i.test(base)) {
    notes.push(`The document has no full server URL${base ? ` ("${base}")` : ''}, so the requests use http://localhost:8080. Change @baseUrl at the top of the file.`);
    base = 'http://localhost:8080' + (base.startsWith('/') ? base : '');
  }
  base = base.replace(/\/+$/, '');
  const variables = { baseUrl: base };
  const requests = [];
  const sec = doc.components && doc.components.securitySchemes || doc.securityDefinitions || {};
  const authHeaders = [];
  for (const s of Object.values(sec)) {
    const v = deref(doc, s);
    if ((v.type === 'http' && /bearer/i.test(v.scheme || '')) || v.type === 'oauth2' || v.type === 'openIdConnect') { authHeaders.push(['Authorization', 'Bearer {{token}}']); variables.token = 'replace-me'; break; }
    if (v.type === 'apiKey' && v.in === 'header' && v.name) { authHeaders.push([v.name, '{{apiKey}}']); variables.apiKey = 'replace-me'; break; }
    if (v.type === 'basic' || (v.type === 'http' && /basic/i.test(v.scheme || ''))) { authHeaders.push(['Authorization', 'Basic {{basicAuth}}']); variables.basicAuth = 'replace-me'; break; }
  }
  for (const [p, item0] of Object.entries(doc.paths || {})) {
    const item = deref(doc, item0);
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      const op = item[method];
      if (!op || typeof op !== 'object') continue;
      const params = [...(item.parameters || []), ...(op.parameters || [])].map((x) => deref(doc, x));
      let path = p.replace(/\{([^}]+)\}/g, (m, k) => {
        const name = k.replace(/[^\w]/g, '_');
        const prm = params.find((x) => x.in === 'path' && x.name === k);
        const ex = prm ? (prm.example !== undefined ? prm.example : sampleOf(doc, prm.schema || { type: prm.type || 'string' })) : 1;
        if (!(name in variables)) variables[name] = String(ex == null ? 1 : ex === 'string' ? 1 : ex);
        return `{{${name}}}`;
      });
      const q = params.filter((x) => x.in === 'query' && x.required).map((x) => [x.name, String(x.example !== undefined ? x.example : sampleOf(doc, x.schema || { type: x.type || 'string' }))]);
      if (q.length) path += '?' + new URLSearchParams(q).toString();
      const headers = [...authHeaders];
      let body = null;
      if (op.requestBody) {
        const rb = deref(doc, op.requestBody);
        const content = rb.content || {};
        const mt = Object.keys(content).find((k) => /json/i.test(k)) || Object.keys(content)[0];
        if (mt) {
          const c = content[mt] || {};
          let ex = c.example;
          if (ex === undefined && c.examples && typeof c.examples === 'object') { const first = Object.values(c.examples)[0]; ex = deref(doc, first).value; }
          if (ex === undefined) ex = sampleOf(doc, c.schema || {});
          body = typeof ex === 'string' ? ex : JSON.stringify(ex, null, 0);
          headers.push(['Content-Type', mt]);
        }
      } else {
        const bp = params.find((x) => x.in === 'body');
        if (bp) { body = JSON.stringify(sampleOf(doc, bp.schema || {})); headers.push(['Content-Type', 'application/json']); }
      }
      const name = op.operationId || op.summary || `${method.toUpperCase()} ${p}`;
      requests.push({ title: `${method.toUpperCase()} ${p}${op.summary ? ` - ${String(op.summary).split('\n')[0]}` : ''}`, name: op.operationId ? safeName(op.operationId) : '', label: String(name), method: method.toUpperCase(), url: '{{baseUrl}}' + path, headers, body });
    }
  }
  if (!requests.length) notes.push('The document has no operations under paths.');
  return { requests, variables, notes, title: doc.info && doc.info.title ? String(doc.info.title) : '' };
}


// ---------------------------------------------------------------------------------------------- detection
function prettyBody(b) {
  if (typeof b !== 'string' || !/^\s*[{[]/.test(b) || b.includes('\n') || b.includes('{{')) return b;
  try { return JSON.stringify(JSON.parse(b), null, 2); } catch { return b; }
}

function parseAny(text) {
  const t = String(text || '').replace(/^﻿/, '').trim();
  if (!t) throw new Error('The file is empty.');
  if (t.startsWith('{') || t.startsWith('[')) { try { return JSON.parse(t); } catch (e) { throw new Error(`The file is not valid JSON: ${e.message}`); } }
  try { return YAML.parse(t, { maxAliasCount: 100, uniqueKeys: false }); } catch (e) { throw new Error(`The file is neither JSON nor YAML: ${String(e.message).split('\n')[0]}`); }
}

function detect(doc) {
  if (!doc || typeof doc !== 'object') return '';
  if (doc.info && /schema\.getpostman\.com|postman/i.test(str(doc.info.schema)) || (doc.info && doc.info._postman_id) || (Array.isArray(doc.item) && doc.info)) return 'postman';
  if (Array.isArray(doc.values) && (doc._postman_variable_scope || doc.name !== undefined)) return 'postman-environment';
  if (doc._type === 'export' || (Array.isArray(doc.resources) && doc.__export_format)) return 'insomnia';
  if (doc.openapi || doc.swagger) return 'openapi';
  return '';
}

/** Any supported file -> { kind, http (text), environments: { name: vars }, count, notes, title }. */
function importText(text) {
  const doc = parseAny(text);
  const kind = detect(doc);
  let r;
  if (kind === 'postman') r = fromPostman(doc);
  else if (kind === 'insomnia') r = fromInsomnia(doc);
  else if (kind === 'openapi') r = fromOpenApi(String(text));
  else if (kind === 'postman-environment') { const e = fromPostmanEnvironment(doc); return { kind, http: '', environments: { [e.name]: e.env }, count: 0, notes: [], title: e.name }; }
  else throw new Error('This is not a supported API collection export (v2.x collection or environment, v4 workspace export) or an OpenAPI / Swagger document.');
  const reqs = r.requests.map((q) => ({ ...q, title: q.title || q.label || q.name, body: prettyBody(q.body) }));
  const header = [`# Imported from ${kind === 'openapi' ? 'OpenAPI' : kind === 'postman' ? 'a v2.x collection export' : 'a v4 workspace export'}${r.title ? `: ${r.title}` : ''}`, `# ${reqs.length} request${reqs.length === 1 ? '' : 's'}. Put the cursor in a request and press Ctrl+Alt+R (Cmd+Alt+R on macOS) to send it.`, ''];
  return { kind, http: header.join('\n') + toHttpText(reqs, { variables: r.variables }), environments: r.environments || {}, count: reqs.length, notes: r.notes || [], title: r.title || '' };
}

module.exports = { importText, fromPostman, fromPostmanEnvironment, fromInsomnia, fromOpenApi, detect, parseAny };
