// Response viewer (webview). Receives { type: 'response', vm } from the extension and draws status, body (tree,
// pretty, raw), headers, cookies, timing and the request that was sent. No network: everything comes by postMessage.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const saved = vscode.getState() || {};
  let state = { tab: saved.tab || 'body', mode: saved.mode || 'tree', find: '' };
  let vm = null;
  let pro = { show: true, licensed: false, row: '' };

  const el = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v; // CSSOM: allowed by the CSP, unlike a style attribute
      else if (k === 'value') e.value = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  };
  const post = (m) => vscode.postMessage(m);
  const keep = () => vscode.setState({ tab: state.tab, mode: state.mode });

  function statusClass(s) { return s >= 500 ? 's5' : s >= 400 ? 's4' : s >= 300 ? 's3' : s >= 200 ? 's2' : 's1'; }

  // ------------------------------------------------------------------ JSON tree
  const MAX_AUTO = 400;
  function jsonNode(key, value, depth, budget) {
    const isObj = value !== null && typeof value === 'object';
    const keyEl = key === null ? null : el('span', { class: 'k' }, Array.isArray(key) ? key[0] : JSON.stringify(key), ': ');
    if (!isObj) {
      const t = value === null ? 'null' : typeof value;
      return el('div', { class: 'row' }, keyEl, el('span', { class: `v ${t}`, title: 'Click to copy', onclick: () => post({ type: 'copy', text: typeof value === 'string' ? value : JSON.stringify(value), what: 'the value' }) }, typeof value === 'string' ? JSON.stringify(value) : String(value)));
    }
    const arr = Array.isArray(value);
    const n = arr ? value.length : Object.keys(value).length;
    const open = depth < 3 && budget.left > 0 && (depth < 1 || n <= 50);
    const head = el('div', { class: 'row' });
    const tw = el('span', { class: `tw ${open ? 'open' : ''}`, role: 'button', 'aria-label': 'expand' }, '');
    head.append(tw, keyEl || '', el('span', { class: 'b' }, arr ? `[${n}]` : `{${n}}`));
    const kids = el('div', { class: 'kids' });
    const wrap = el('div', { class: 'node' }, head, kids);
    let filled = false;
    const fill = () => {
      if (filled) return;
      filled = true;
      const entries = arr ? value.map((v, i) => [[String(i)], v]) : Object.entries(value);
      const limit = 2000;
      entries.slice(0, limit).forEach(([k, v]) => kids.append(jsonNode(k, v, depth + 1, budget)));
      if (entries.length > limit) kids.append(el('div', { class: 'more' }, `${entries.length - limit} more items. Use Open in editor for the whole body.`));
    };
    if (open) { budget.left -= n; fill(); } else kids.hidden = true;
    head.addEventListener('click', (e) => {
      if (e.target.classList.contains('v')) return;
      fill(); kids.hidden = !kids.hidden; tw.classList.toggle('open', !kids.hidden);
    });
    return wrap;
  }

  // ------------------------------------------------------------------ text with find highlights
  function textBlock(text, cls) {
    const pre = el('pre', { class: `code ${cls || ''}` });
    const q = state.find;
    if (!q) { pre.textContent = text; return pre; }
    const lower = text.toLowerCase(), ql = q.toLowerCase();
    let i = 0, hits = 0;
    while (i < text.length) {
      const j = lower.indexOf(ql, i);
      if (j < 0 || hits > 5000) { pre.append(text.slice(i)); break; }
      pre.append(text.slice(i, j), el('mark', null, text.slice(j, j + q.length)));
      hits++; i = j + q.length;
    }
    return pre;
  }

  // ------------------------------------------------------------------ tabs
  function bodyView() {
    const wrap = el('div', { class: 'body' });
    if (vm.kind === 'image' && vm.image) { wrap.append(el('div', { class: 'img' }, el('img', { src: vm.image, alt: 'Response image' }))); return wrap; }
    if (vm.kind === 'binary') { wrap.append(el('p', { class: 'note' }, vm.text)); return wrap; }
    if (vm.cut) wrap.append(el('p', { class: 'note' }, `The body is ${vm.sizeText}; the first 2 MB show here. `, el('a', { href: '#', onclick: (e) => { e.preventDefault(); post({ type: 'openBody' }); } }, 'Open the whole body in an editor'), '.'));
    if (vm.truncatedDownload) wrap.append(el('p', { class: 'note warn' }, 'The download stopped at the size limit (setting zovoRest.maxBodyMB).'));
    const modes = vm.json != null ? ['tree', 'pretty', 'raw'] : vm.kind === 'xml' || vm.kind === 'html' ? ['pretty', 'raw'] : ['raw'];
    let mode = modes.includes(state.mode) ? state.mode : modes[0];
    if (modes.length > 1) {
      const bar = el('div', { class: 'modes', role: 'tablist' });
      for (const m of modes) bar.append(el('button', { class: m === mode ? 'on' : '', role: 'tab', 'aria-selected': String(m === mode), onclick: () => { state.mode = m; keep(); render(); } }, m === 'tree' ? 'Tree' : m === 'pretty' ? 'Pretty' : 'Raw'));
      wrap.append(bar);
    }
    if (mode === 'tree' && vm.json != null) {
      if (state.find) mode = 'pretty';
      else { const t = el('div', { class: 'tree' }); t.append(jsonNode(null, vm.json, 0, { left: MAX_AUTO })); wrap.append(t); return wrap; }
    }
    const text = mode === 'raw' ? vm.text : (vm.pretty || vm.text);
    wrap.append(text ? textBlock(text, vm.kind) : el('p', { class: 'note' }, 'The response has no body.'));
    return wrap;
  }

  function table(rows, cols) {
    const t = el('table', null, el('thead', null, el('tr', null, cols.map((c) => el('th', null, c)))));
    const tb = el('tbody');
    for (const r of rows) tb.append(el('tr', null, r.map((c, i) => el('td', { class: i === 0 ? 'name' : 'val', title: 'Click to copy', onclick: () => post({ type: 'copy', text: String(c), what: i === 0 ? 'the name' : 'the value' }) }, String(c)))));
    t.append(tb);
    return t;
  }

  function headersView() {
    return el('div', { class: 'pad' }, table(vm.headers, ['Name', 'Value']),
      vm.redirects && vm.redirects.length ? el('div', { class: 'redir' }, el('h4', null, 'Redirects'), vm.redirects.map((r) => el('div', { class: 'mono' }, `${r.status} ${r.url} → ${r.location}`))) : null);
  }

  function cookiesView() {
    if (!vm.cookies.length) return el('p', { class: 'note pad' }, 'The response sets no cookies. Cookies are kept in memory for this window and sent with later requests to the same site (setting zovoRest.rememberCookies).');
    return el('div', { class: 'pad' }, table(vm.cookies.map((c) => [c.name, c.value, c.attributes]), ['Name', 'Value', 'Attributes']));
  }

  function timingView() {
    const t = vm.timings;
    const parts = [['DNS lookup', t.dns], ['TCP connect', t.tcp], ['TLS handshake', t.tls], ['Waiting (time to first byte)', t.ttfb], ['Download', t.download]];
    const total = Math.max(1, t.total);
    let at = 0;
    const rows = parts.map(([name, ms]) => {
      const left = (at / total) * 100, width = Math.max(0.5, (ms / total) * 100);
      at += ms;
      return el('div', { class: 'trow' }, el('span', { class: 'tname' }, name), el('span', { class: 'tbar' }, el('span', { class: 'tfill', style: `margin-left:${left.toFixed(2)}%;width:${width.toFixed(2)}%` })), el('span', { class: 'tms' }, `${ms.toFixed(1)} ms`));
    });
    return el('div', { class: 'pad timing' }, rows, el('div', { class: 'trow total' }, el('span', { class: 'tname' }, 'Total'), el('span'), el('span', { class: 'tms' }, `${t.total.toFixed(1)} ms`)),
      el('p', { class: 'note' }, 'A request on a kept-alive or reused connection shows 0 ms for DNS, TCP and TLS. Each request here opens a new connection.'));
  }

  function requestView() {
    const r = vm.request;
    if (!r) return el('p', { class: 'note pad' }, 'No request details.');
    return el('div', { class: 'pad' }, el('div', { class: 'mono reqline' }, `${r.method} ${r.url}`), table(r.headers, ['Name', 'Value']), r.body ? textBlock(r.body, 'req') : null,
      el('div', { class: 'acts' }, el('button', { onclick: () => post({ type: 'copyCurl' }) }, 'Copy as cURL')));
  }

  // ------------------------------------------------------------------ frame
  function proRow() {
    if (!pro.show || pro.licensed || !pro.row) return null;
    try { if (sessionStorage.getItem('zovo.reach1.closed') === '1') return null; } catch (e) { /* no storage */ }
    const holder = el('div', { class: 'reach' });
    holder.innerHTML = pro.row; // built by the extension (license/reach1.js), escaped there
    holder.addEventListener('click', (e) => {
      const c = e.target.closest && e.target.closest('.zovo-reach1-close');
      if (!c) return;
      try { sessionStorage.setItem('zovo.reach1.closed', '1'); } catch (err) { /* ignore */ }
      holder.remove();
    });
    return holder;
  }

  function footer() {
    const f = document.getElementById('zovo-footer');
    return f ? f.content.cloneNode(true) : null;
  }

  function render() {
    app.textContent = '';
    if (!vm) { app.append(el('p', { class: 'empty' }, 'Send a request from a .http or .rest file. The response shows here.'), footer() || ''); return; }
    const head = el('header', { class: 'head' },
      el('span', { class: `status ${statusClass(vm.status)}` }, `${vm.status} ${vm.statusText || ''}`.trim()),
      el('span', { class: 'meta' }, `${vm.time} ms`), el('span', { class: 'meta' }, vm.sizeText),
      el('span', { class: 'meta type', title: vm.type }, vm.type ? vm.type.split(';')[0] : 'no content type'),
      el('span', { class: 'grow' }),
      el('button', { title: 'Send the same request again (Ctrl+Alt+R in the .http file)', onclick: () => post({ type: 'resend' }) }, 'Send again'),
      el('button', { title: 'Copy the body', onclick: () => post({ type: 'copyBody' }) }, 'Copy'),
      el('button', { title: 'Save the body to a file', onclick: () => post({ type: 'saveBody' }) }, 'Save'),
      el('button', { title: 'Open the body in an editor tab', onclick: () => post({ type: 'openBody' }) }, 'Open'),
      el('button', { title: 'Open the full response with status line and headers', onclick: () => post({ type: 'openBody', raw: true }) }, 'Full response'));
    const label = el('div', { class: 'label mono', title: vm.url }, vm.request ? `${vm.request.method} ${vm.url}` : vm.url);
    const tabs = el('nav', { class: 'tabs', role: 'tablist' });
    const names = [['body', 'Body'], ['headers', `Headers (${vm.headers.length})`], ['cookies', `Cookies (${vm.cookies.length})`], ['timing', 'Timing'], ['request', 'Request']];
    for (const [id, name] of names) tabs.append(el('button', { class: state.tab === id ? 'on' : '', role: 'tab', 'aria-selected': String(state.tab === id), onclick: () => { state.tab = id; keep(); render(); } }, name));
    if (state.tab === 'body' && vm.kind !== 'image' && vm.kind !== 'binary') {
      const find = el('input', { type: 'search', class: 'find', placeholder: 'Find in body', value: state.find, 'aria-label': 'Find in body' });
      find.addEventListener('input', () => { state.find = find.value; clearTimeout(find._t); find._t = setTimeout(() => { const pos = find.selectionStart; render(); const f = app.querySelector('.find'); if (f) { f.focus(); f.setSelectionRange(pos, pos); } }, 200); });
      tabs.append(el('span', { class: 'grow' }), find);
    }
    const view = state.tab === 'headers' ? headersView() : state.tab === 'cookies' ? cookiesView() : state.tab === 'timing' ? timingView() : state.tab === 'request' ? requestView() : bodyView();
    app.append(head, label, proRow() || '', tabs, el('main', { class: 'view' }, view), footer() || '');
    const m = app.querySelector('mark');
    if (m && state.find) m.scrollIntoView({ block: 'center' });
  }

  function renderError(msg) {
    app.textContent = '';
    app.append(el('header', { class: 'head' }, el('span', { class: 'status s5' }, 'No response'), msg.timings ? el('span', { class: 'meta' }, `${msg.timings.total} ms`) : '', el('span', { class: 'grow' }), el('button', { onclick: () => post({ type: 'resend' }) }, 'Try again')),
      el('div', { class: 'label mono' }, msg.label || ''), el('p', { class: 'error pad' }, msg.message), proRow() || '', footer() || '');
  }

  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.pro) pro = m.pro;
    if (m.type === 'response') { vm = m.vm; state.find = ''; render(); }
    else if (m.type === 'error') { vm = null; renderError(m); }
    else if (m.type === 'pro' && vm) render();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f' && vm) { e.preventDefault(); state.tab = 'body'; render(); const f = app.querySelector('.find'); if (f) f.focus(); }
  });
  render();
  post({ type: 'ready' });
}());
