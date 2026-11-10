/* Deep Stellar Station: toolbar, tabs, panel and dialogs. */
(function () {
  'use strict';
  const T = window.__TAURI__;
  const invoke = T.core.invoke;
  const listen = T.event.listen;
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // ---------------------------------------------------------------- settings & stores
  const DEFAULTS = { theme: 'nebula', search: 'ddg', customSearch: '', httpsOnly: true, shield: true, bangs: true, bangsBare: false, still: false, listsUpdated: 0 };
  let settings = Object.assign({}, DEFAULTS);
  let bookmarks = [];
  async function load(name, def) {
    try { const s = await invoke('store_get', { name }); return s ? JSON.parse(s) : def; } catch (e) { return def; }
  }
  const store = (name, obj) => invoke('store_set', { name, content: JSON.stringify(obj) }).catch(console.error);
  const saveSettings = () => store('settings', settings);
  const saveBookmarks = () => store('bookmarks', bookmarks);

  // ---------------------------------------------------------------- search
  const ENGINES = {
    ddg: ['DuckDuckGo', 'https://duckduckgo.com/?q=%s&kp=-2'],
    ddg_lite: ['DuckDuckGo Lite', 'https://lite.duckduckgo.com/lite/?q=%s'],
    brave: ['Brave Search', 'https://search.brave.com/search?q=%s'],
    startpage: ['Startpage', 'https://www.startpage.com/do/search?q=%s'],
    mojeek: ['Mojeek', 'https://www.mojeek.com/search?q=%s'],
    custom: ['Custom address', ''],
  };
  const BANGS = {
    w: 'https://en.wikipedia.org/w/index.php?search=%s', gh: 'https://github.com/search?q=%s',
    yt: 'https://www.youtube.com/results?search_query=%s', r: 'https://www.reddit.com/search/?q=%s',
    so: 'https://stackoverflow.com/search?q=%s', mdn: 'https://developer.mozilla.org/en-US/search?q=%s',
    osm: 'https://www.openstreetmap.org/search?query=%s', aw: 'https://web.archive.org/web/*/%s',
    ddg: 'https://duckduckgo.com/?q=%s', b: 'https://search.brave.com/search?q=%s', sp: 'https://www.startpage.com/do/search?q=%s',
    arch: 'https://wiki.archlinux.org/index.php?search=%s', fd: 'https://search.f-droid.org/?q=%s',
    npm: 'https://www.npmjs.com/search?q=%s', pypi: 'https://pypi.org/search/?q=%s', crates: 'https://crates.io/search?q=%s',
  };
  function searchUrl(q) {
    let t = settings.search === 'custom' && /^https?:\/\/.+%s/.test(settings.customSearch) ? settings.customSearch : (ENGINES[settings.search] || ENGINES.ddg)[1];
    if (!t) t = ENGINES.ddg[1];
    return t.replace('%s', encodeURIComponent(q));
  }
  function bang(text) {
    if (!settings.bangs) return null;
    const m = text.match(/^(!?)([a-z0-9]{1,12})\s+(.+)$/i);
    if (!m) return null;
    const explicit = m[1] === '!';
    if (!explicit && (!settings.bangsBare || m[2].length < 2)) return null;
    const t = BANGS[m[2].toLowerCase()];
    if (!t) return null;
    return t.replace('%s', t.includes('web.archive.org/web/') ? m[3] : encodeURIComponent(m[3]));
  }
  // Tracking tags removed from addresses before they load.
  const TRACK = /^(utm_\w+|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|yclid|twclid|ttclid|mc_cid|mc_eid|igshid|igsh|_hsenc|_hsmi|mkt_tok|oly_anon_id|oly_enc_id|ref_src|spm|scm)$/i;
  function clean(u) {
    try {
      const x = new URL(u);
      // Unwrap common click-through redirects.
      const host = x.hostname;
      const q = (k) => x.searchParams.get(k);
      let target = null;
      if (/(^|\.)google\./.test(host) && x.pathname === '/url') target = q('q') || q('url');
      else if (/^(l|lm)\.facebook\.com$/.test(host) || host === 'l.instagram.com') target = q('u');
      else if (/duckduckgo\.com$/.test(host) && x.pathname.startsWith('/l/')) target = q('uddg');
      else if (/youtube\.com$/.test(host) && x.pathname === '/redirect') target = q('q');
      else if (host === 'out.reddit.com') target = q('url');
      if (target && /^https?:\/\//.test(target)) return clean(target);
      let changed = false;
      for (const k of [...x.searchParams.keys()]) if (TRACK.test(k)) { x.searchParams.delete(k); changed = true; }
      return changed ? x.toString() : u;
    } catch (e) { return u; }
  }
  function resolveInput(raw) {
    const text = raw.trim();
    if (!text) return null;
    const b = bang(text);
    if (b) return b;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return clean(text);
    if (!/\s/.test(text) && (/^localhost(:\d+)?(\/.*)?$/i.test(text) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text))) {
      return clean((settings.httpsOnly || !/^localhost/i.test(text) ? 'https://' : 'http://') + text);
    }
    return searchUrl(text);
  }

  // ---------------------------------------------------------------- tabs
  const tabs = []; // {label, url, title, loading}
  let active = null;
  const startUrl = () => location.origin + '/start.html?theme=' + encodeURIComponent(settings.theme) + (settings.still ? '&still=1' : '');
  const isStart = (u) => !!u && u.startsWith(location.origin + '/start.html');
  const tab = (label) => tabs.find((t) => t.label === label);
  const current = () => tab(active);

  function titleFor(t) {
    if (isStart(t.url)) return 'New tab';
    try { const h = new URL(t.url).hostname.replace(/^www\./, ''); return h || t.url; } catch (e) { return t.url || 'Loading…'; }
  }

  async function newTab(url) {
    const target = url ? clean(url) : startUrl();
    try {
      const label = await invoke('tab_new', { url: target });
      tabs.push({ label, url: target, loading: true });
      active = label;
      render();
      if (!url) setTimeout(() => $('#address').focus(), 50);
    } catch (e) { toast('Couldn\'t open a tab: ' + e); }
  }

  async function closeTab(label) {
    const i = tabs.findIndex((t) => t.label === label);
    if (i < 0) return;
    const closed = tabs.splice(i, 1)[0];
    recentlyClosed.push(closed.url);
    if (recentlyClosed.length > 10) recentlyClosed.shift();
    await invoke('tab_close', { label });
    if (active === label) active = tabs.length ? tabs[Math.min(i, tabs.length - 1)].label : null;
    if (!tabs.length) await newTab();
    else { await invoke('tab_activate', { label: active }); render(); }
  }
  const recentlyClosed = []; // memory only

  async function activate(label) {
    active = label;
    await invoke('tab_activate', { label });
    render();
  }

  async function go(raw, label = active) {
    const url = resolveInput(raw);
    if (!url || !label) return;
    const t = tab(label);
    if (t) { t.url = url; t.loading = true; }
    $('#address').blur();
    try { await invoke('tab_navigate', { label, url }); } catch (e) { toast(String(e)); }
    render();
  }

  function render() {
    const box = $('#tabs');
    box.textContent = '';
    for (const t of tabs) {
      const d = el('div', 'tab' + (t.label === active ? ' on' : ''));
      d.setAttribute('role', 'tab');
      d.setAttribute('aria-selected', t.label === active ? 'true' : 'false');
      d.title = t.url;
      if (t.loading) d.appendChild(el('span', 'spin'));
      d.appendChild(el('span', 't', titleFor(t)));
      const x = el('button', 'x', '✕');
      x.setAttribute('aria-label', 'Close tab ' + titleFor(t));
      x.onclick = (e) => { e.stopPropagation(); closeTab(t.label); };
      d.appendChild(x);
      d.onclick = () => activate(t.label);
      d.onauxclick = (e) => { if (e.button === 1) closeTab(t.label); };
      box.appendChild(d);
    }
    const t = current();
    if (t && document.activeElement !== $('#address')) $('#address').value = isStart(t.url) ? '' : t.url;
    $('#lock').textContent = t && t.url.startsWith('https://') ? '🔒' : (t && t.url.startsWith('http://') ? '⚠' : '');
    $('#progress').style.width = t && t.loading ? '70%' : '0';
    $('#bookmark').classList.toggle('on', !!(t && bookmarks.some((b) => b.url === t.url)));
    $('#bookmark').textContent = t && bookmarks.some((b) => b.url === t.url) ? '★' : '☆';
  }

  // ---------------------------------------------------------------- layout
  let panelOpen = false;
  let dialogOpen = false;
  function layout() {
    const top = $('#tabbar').offsetHeight + $('#navbar').offsetHeight;
    invoke('set_layout', { top, right: panelOpen ? $('#panel').offsetWidth : 0, hidden: dialogOpen }).catch(console.error);
  }
  window.addEventListener('resize', layout);

  function togglePanel(pane, force) {
    panelOpen = force != null ? force : !panelOpen;
    $('#panel').hidden = !panelOpen;
    if (pane) showPane(pane);
    layout();
  }
  function showPane(p) {
    document.querySelectorAll('.panelTabs [data-pane]').forEach((b) => b.classList.toggle('on', b.dataset.pane === p));
    document.querySelectorAll('.pane').forEach((s) => { s.hidden = s.id !== 'pane-' + p; });
    if (p === 'link') { $('#inboxBadge').hidden = true; renderLink(); }
    if (p === 'bookmarks') renderBookmarks();
    if (p === 'downloads') renderDownloads();
  }

  function openDialog(build) {
    const d = $('#dialog');
    d.textContent = '';
    build(d);
    dialogOpen = true;
    $('#overlay').hidden = false;
    layout();
  }
  function closeDialog() {
    dialogOpen = false;
    $('#overlay').hidden = true;
    StationLink.cancelPairing();
    layout();
  }
  $('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closeDialog(); });

  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
  }

  // ---------------------------------------------------------------- events from tabs
  listen('tab://state', (e) => {
    const t = tab(e.payload.label);
    if (!t) return;
    t.url = e.payload.url;
    t.loading = e.payload.loading;
    render();
  });
  listen('tab://special', (e) => {
    const { label, url } = e.payload;
    let u;
    try { u = new URL(url); } catch (x) { return; }
    if (u.protocol === 'dsb:') {
      const what = u.hostname || u.pathname.replace(/^\/+/, '');
      if (what === 'search') go(u.searchParams.get('q') || '', label);
      else if (what === 'bookmarks') togglePanel('bookmarks', true);
      else if (what === 'projects') go('https://github.com/courier-iot', label);
      else if (what === 'shortcut-add') addShortcutDialog();
    } else if (u.protocol === 'magnet:') {
      toast('Torrents are in Deep Stellar Browsing on Android. Send this page to your phone from the side panel.');
    } else {
      toast('This link needs another app: ' + u.protocol.replace(':', ''));
    }
  });

  const downloads = []; // memory only
  listen('dl://state', (e) => {
    const p = e.payload;
    const d = downloads.find((x) => x.url === p.url && !x.done) || (downloads.unshift({ url: p.url }), downloads[0]);
    Object.assign(d, p);
    if (!p.done) toast('Downloading ' + (p.path.split(/[\\/]/).pop() || 'file') + '…');
    else toast(p.success ? 'Downloaded ' + p.path.split(/[\\/]/).pop() : 'Download failed');
    renderDownloads();
  });

  // ---------------------------------------------------------------- toolbar wiring
  $('#addressForm').addEventListener('submit', (e) => { e.preventDefault(); go($('#address').value); });
  $('#address').addEventListener('focus', () => $('#address').select());
  $('#back').onclick = () => active && invoke('tab_action', { label: active, action: 'back' });
  $('#forward').onclick = () => active && invoke('tab_action', { label: active, action: 'forward' });
  $('#reload').onclick = () => active && invoke('tab_action', { label: active, action: current() && current().loading ? 'stop' : 'reload' });
  $('#home').onclick = () => active && invoke('tab_navigate', { label: active, url: startUrl() });
  $('#newTab').onclick = () => newTab();
  $('#panelBtn').onclick = () => togglePanel(null);
  $('#panelClose').onclick = () => togglePanel(null, false);
  document.querySelectorAll('.panelTabs [data-pane]').forEach((b) => { b.onclick = () => showPane(b.dataset.pane); });
  $('#bookmark').onclick = toggleBookmark;
  $('#shield').onclick = async () => {
    settings.shield = !settings.shield;
    await invoke('shield_set', { enabled: settings.shield });
    saveSettings();
    $('#shield').classList.toggle('off', !settings.shield);
    toast(settings.shield ? 'Shield on' : 'Shield off for all sites. Reload pages to see the difference.');
  };
  $('#menuBtn').onclick = openMenu;

  setInterval(async () => {
    try {
      const s = await invoke('shield_stats');
      $('#shieldCount').textContent = s.blocked ? (s.blocked > 999 ? '1k+' : String(s.blocked)) : '';
      $('#shield').title = `Ad & tracker shield: ${s.enabled ? 'on' : 'off'} · ${s.blocked} blocked this session · ${s.domains} domains listed`;
    } catch (e) {}
  }, 2000);

  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (e.ctrlKey && k === 't') { e.preventDefault(); newTab(); }
    else if (e.ctrlKey && k === 'w') { e.preventDefault(); active && closeTab(active); }
    else if (e.ctrlKey && e.shiftKey && k === 't') { e.preventDefault(); const u = recentlyClosed.pop(); if (u) newTab(u); }
    else if (e.ctrlKey && k === 'l') { e.preventDefault(); $('#address').focus(); }
    else if (e.ctrlKey && k === 'r') { e.preventDefault(); $('#reload').click(); }
    else if (e.ctrlKey && k === 'd') { e.preventDefault(); toggleBookmark(); }
    else if (e.ctrlKey && k === 'tab') {
      e.preventDefault();
      const i = tabs.findIndex((t) => t.label === active);
      const n = tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length];
      if (n) activate(n.label);
    }
    else if (e.altKey && e.key === 'ArrowLeft') $('#back').click();
    else if (e.altKey && e.key === 'ArrowRight') $('#forward').click();
    else if (e.key === 'Escape' && dialogOpen) closeDialog();
  });

  // ---------------------------------------------------------------- bookmarks (Netscape format = works with every browser)
  async function toggleBookmark() {
    const t = current();
    if (!t || isStart(t.url)) return;
    const i = bookmarks.findIndex((b) => b.url === t.url);
    if (i >= 0) { bookmarks.splice(i, 1); toast('Bookmark removed'); }
    else { bookmarks.push({ title: titleFor(t), url: t.url, folder: '', added: Math.floor(Date.now() / 1000) }); toast('Bookmarked ✦'); }
    await saveBookmarks();
    render();
    if (!$('#pane-bookmarks').hidden) renderBookmarks();
  }

  function renderBookmarks() {
    const box = $('#bookmarks');
    box.textContent = '';
    const f = $('#bmFilter').value.trim().toLowerCase();
    const list = bookmarks.filter((b) => !f || b.title.toLowerCase().includes(f) || b.url.toLowerCase().includes(f));
    if (!list.length) box.appendChild(el('p', 'dim', bookmarks.length ? 'No matches.' : 'No bookmarks yet. Press ☆ on a page, or import from another browser.'));
    let folder = null;
    for (const b of list.slice().sort((a, c) => a.folder.localeCompare(c.folder))) {
      if (b.folder !== folder) { folder = b.folder; if (folder) box.appendChild(el('div', 'sectionLabel', folder.toUpperCase())); }
      const c = el('div', 'card');
      const h = el('div', 'h'); h.appendChild(el('b', null, b.title || b.url)); c.appendChild(h);
      c.appendChild(el('div', 's', b.url));
      const a = el('div', 'a');
      const open = el('button', null, 'Open'); open.onclick = () => go(b.url);
      const tabBtn = el('button', null, 'New tab'); tabBtn.onclick = () => newTab(b.url);
      const del = el('button', null, 'Delete'); del.onclick = async () => { bookmarks = bookmarks.filter((x) => x !== b); await saveBookmarks(); renderBookmarks(); render(); };
      a.append(open, tabBtn, del); c.appendChild(a);
      box.appendChild(c);
    }
  }
  $('#bmFilter').addEventListener('input', renderBookmarks);
  $('#bmImport').onclick = () => $('#bmFile').click();
  $('#bmFile').addEventListener('change', async () => {
    const file = $('#bmFile').files[0];
    if (!file) return;
    const doc = new DOMParser().parseFromString(await file.text(), 'text/html');
    const seen = new Set(bookmarks.map((b) => b.folder + '\u0000' + b.url));
    let added = 0;
    (function walk(dl, path) {
      for (const dt of dl.querySelectorAll(':scope > dt')) {
        const a = dt.querySelector(':scope > a');
        const h3 = dt.querySelector(':scope > h3');
        if (a && /^https?:\/\//i.test(a.getAttribute('href') || '')) {
          const b = { title: a.textContent.trim(), url: a.getAttribute('href'), folder: path.join('/'), added: Number(a.getAttribute('add_date')) || Math.floor(Date.now() / 1000) };
          if (!seen.has(b.folder + '\u0000' + b.url)) { seen.add(b.folder + '\u0000' + b.url); bookmarks.push(b); added++; }
        } else if (h3) {
          const sub = dt.querySelector(':scope > dl') || (dt.nextElementSibling && dt.nextElementSibling.tagName === 'DL' ? dt.nextElementSibling : null);
          if (sub) walk(sub, path.concat(h3.textContent.trim()));
        }
      }
    })(doc.querySelector('dl') || doc.body, []);
    await saveBookmarks();
    $('#bmFile').value = '';
    toast(`Imported ${added} new bookmark${added === 1 ? '' : 's'}`);
    renderBookmarks();
  });
  $('#bmExport').onclick = async () => {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const tree = { links: [], kids: {} };
    for (const b of bookmarks) {
      let n = tree;
      for (const part of b.folder.split('/').filter(Boolean)) n = n.kids[part] = n.kids[part] || { links: [], kids: {} };
      n.links.push(b);
    }
    let out = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n';
    (function write(n, ind) {
      for (const b of n.links) out += `${ind}<DT><A HREF="${esc(b.url)}" ADD_DATE="${b.added || 0}">${esc(b.title || b.url)}</A>\n`;
      for (const [name, kid] of Object.entries(n.kids)) { out += `${ind}<DT><H3>${esc(name)}</H3>\n${ind}<DL><p>\n`; write(kid, ind + '    '); out += `${ind}</DL><p>\n`; }
    })(tree, '    ');
    out += '</DL><p>\n';
    try {
      const p = await invoke('save_text', { name: 'deep-stellar-bookmarks-' + new Date().toISOString().slice(0, 10) + '.html', content: out });
      toast('Exported to ' + p);
    } catch (e) { toast('Export failed: ' + e); }
  };

  // ---------------------------------------------------------------- downloads
  function renderDownloads() {
    const box = $('#downloads');
    box.textContent = '';
    if (!downloads.length) { box.appendChild(el('p', 'dim', 'Nothing downloaded this session. Files go to Downloads/DeepStellar; this list is never saved.')); return; }
    for (const d of downloads) {
      const c = el('div', 'card');
      const h = el('div', 'h'); h.appendChild(el('b', null, (d.path || d.url).split(/[\\/]/).pop())); c.appendChild(h);
      c.appendChild(el('div', 's', d.done ? (d.success ? 'Done · ' + d.path : 'Failed') : 'Downloading…'));
      if (d.done && d.success) {
        const a = el('div', 'a');
        const o = el('button', null, 'Open'); o.onclick = () => invoke('open_file', { path: d.path }).catch((e) => toast(String(e)));
        a.appendChild(o); c.appendChild(a);
      }
      box.appendChild(c);
    }
  }
  $('#openDownloads').onclick = () => invoke('open_downloads').catch((e) => toast(String(e)));

  // ---------------------------------------------------------------- linked devices
  const inbox = []; // loaded from / saved to inbox.json
  const saveInbox = () => store('inbox', inbox.slice(0, 300));

  function renderLink() {
    const peers = StationLink.peers();
    $('#linkEmpty').hidden = peers.length > 0;
    $('#noteForm').hidden = peers.length === 0;
    const pbox = $('#linkPeers');
    pbox.textContent = '';
    if (peers.length) {
      pbox.appendChild(el('div', 'sectionLabel', 'LINKED PHONES'));
      for (const p of peers) {
        const c = el('div', 'card');
        const h = el('div', 'h');
        h.appendChild(el('span', 'dot' + (p.online ? ' on' : '')));
        h.appendChild(el('b', null, p.name));
        c.appendChild(h);
        c.appendChild(el('div', 's', (p.online ? 'Connected' : 'Not connected — opens when the phone app is on this Wi-Fi') + (p.pending ? ` · ${p.pending} waiting to send` : '')));
        const a = el('div', 'a');
        const send = el('button', null, 'Send this page');
        send.onclick = () => sendPage(p.fp);
        const un = el('button', null, 'Unlink');
        un.onclick = () => { if (confirm('Unlink ' + p.name + '? It will need to scan a new code to link again.')) StationLink.unpair(p.fp); };
        a.append(send, un);
        c.appendChild(a);
        pbox.appendChild(c);
      }
      const more = el('button', null, '＋ Link another phone');
      more.onclick = pairDialog;
      pbox.appendChild(more);
    }
    const sel = $('#noteTo');
    const prev = sel.value;
    sel.textContent = '';
    for (const p of peers) { const o = el('option', null, p.name); o.value = p.fp; sel.appendChild(o); }
    if (prev) sel.value = prev;

    const box = $('#inbox');
    box.textContent = '';
    if (inbox.length) box.appendChild(el('div', 'sectionLabel', 'SHARED'));
    for (const m of inbox) {
      const c = el('div', 'card msg' + (m.dir === 'out' ? ' out' : ''));
      const h = el('div', 'h');
      h.appendChild(el('b', null, m.dir === 'out' ? 'You → ' + m.to : m.from));
      h.appendChild(el('span', 'dim', new Date(m.ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })));
      c.appendChild(h);
      if (m.title) c.appendChild(el('div', null, m.title));
      if (m.url) { const a = el('a', null, m.url); a.href = '#'; a.onclick = (e) => { e.preventDefault(); newTab(m.url); }; c.appendChild(a); }
      if (m.text) c.appendChild(el('div', null, m.text));
      const act = el('div', 'a');
      if (m.url) { const o = el('button', null, 'Open'); o.onclick = () => newTab(m.url); act.appendChild(o); }
      const cp = el('button', null, 'Copy'); cp.onclick = () => navigator.clipboard.writeText(m.url || m.text).then(() => toast('Copied'));
      const del = el('button', null, 'Delete'); del.onclick = () => { inbox.splice(inbox.indexOf(m), 1); saveInbox(); renderLink(); };
      act.append(cp, del);
      c.appendChild(act);
      box.appendChild(c);
    }
  }

  async function sendPage(peerFp) {
    const t = current();
    if (!t || isStart(t.url)) { toast('Open a page first'); return; }
    const body = await StationLink.sendLink(peerFp, t.url, titleFor(t));
    const p = StationLink.peers().find((x) => x.fp === peerFp);
    inbox.unshift({ id: body.id, ts: body.ts, kind: 'link', url: t.url, title: titleFor(t), dir: 'out', to: p ? p.name : 'phone' });
    saveInbox();
    toast(p && p.online ? 'Sent to ' + p.name : 'Will send when ' + (p ? p.name : 'the phone') + ' connects');
    renderLink();
  }

  $('#noteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('#noteText').value.trim();
    const to = $('#noteTo').value;
    if (!text || !to) return;
    const isUrl = /^https?:\/\/\S+$/i.test(text);
    const body = isUrl ? await StationLink.sendLink(to, text, '') : await StationLink.sendText(to, text);
    const p = StationLink.peers().find((x) => x.fp === to);
    inbox.unshift({ id: body.id, ts: body.ts, kind: isUrl ? 'link' : 'text', url: isUrl ? text : '', text: isUrl ? '' : text, dir: 'out', to: p ? p.name : 'phone' });
    saveInbox();
    $('#noteText').value = '';
    renderLink();
  });
  $('#pairBtn').onclick = pairDialog;

  async function pairDialog() {
    let qrText;
    try { qrText = await StationLink.newPairing(); } catch (e) { toast(String(e.message || e)); return; }
    const svg = await invoke('qr_svg', { text: qrText });
    const ni = StationLink.networkInfo;
    openDialog((d) => {
      d.appendChild(el('h2', null, 'Link a phone'));
      d.appendChild(el('p', null, 'On your phone, open Deep Stellar Browsing → Menu → Scan a QR code, and point it here. Both devices must be on the same Wi-Fi.'));
      const q = el('div', 'qr');
      q.innerHTML = svg; // generated by the app from our own text
      d.appendChild(q);
      d.appendChild(el('p', 'dim', 'The code works once and expires in 10 minutes. Anyone who can see it can link, so close this if someone is looking over your shoulder.'));
      if (ni && !ni.mdns) d.appendChild(el('p', 'dim', 'Network discovery is unavailable on this computer; the phone will connect to ' + (ni.addrs[0] || 'this computer') + ' directly.'));
      if (ni && !ni.addrs.length) d.appendChild(el('p', 'dim', '⚠ No network address found. Connect to Wi-Fi or a network cable first.'));
      const a = el('div', 'actions');
      const done = el('button', null, 'Close');
      done.onclick = closeDialog;
      a.appendChild(done);
      d.appendChild(a);
    });
  }

  StationLink.on('change', () => { if (!$('#pane-link').hidden) renderLink(); });
  StationLink.on('paired', (p) => {
    closeDialog();
    toast('Linked with ' + p.name + ' ✦');
    togglePanel('link', true);
  });
  StationLink.on('message', (m) => {
    inbox.unshift(m);
    saveInbox();
    toast((m.kind === 'link' ? 'Link from ' : 'Note from ') + m.from + ': ' + (m.title || m.url || m.text).slice(0, 60));
    if ($('#panel').hidden || $('#pane-link').hidden) $('#inboxBadge').hidden = false;
    renderLink();
  });

  // ---------------------------------------------------------------- start-page shortcuts (kept for the shared start page)
  function addShortcutDialog() {
    toast('Start-page shortcuts are coming to Station soon; bookmarks work today.');
  }

  // ---------------------------------------------------------------- menu & settings
  function openMenu() {
    openDialog((d) => {
      d.appendChild(el('h2', null, 'Deep Stellar Station'));
      const list = el('div', 'menuList');
      const item = (title, sub, fn) => { const b = el('button'); b.appendChild(el('span', null, title)); if (sub) b.appendChild(el('small', null, sub)); b.onclick = () => { closeDialog(); fn(); }; list.appendChild(b); };
      item('New tab', 'Ctrl+T', () => newTab());
      if (recentlyClosed.length) item('Reopen closed tab', 'Ctrl+Shift+T', () => newTab(recentlyClosed.pop()));
      item('Link a phone', 'Share links with Deep Stellar Browsing on Android', pairDialog);
      item('Bookmarks', 'Import and export work with every browser', () => togglePanel('bookmarks', true));
      item('Downloads', 'Saved to Downloads/DeepStellar', () => togglePanel('downloads', true));
      item('Zoom in', null, () => active && invoke('tab_action', { label: active, action: 'zoom-in' }));
      item('Zoom out', null, () => active && invoke('tab_action', { label: active, action: 'zoom-out' }));
      item('Print / save as PDF', null, () => active && invoke('tab_action', { label: active, action: 'print' }));
      item('Settings', null, openSettings);
      d.appendChild(list);
    });
  }

  function openSettings() {
    openDialog((d) => {
      d.appendChild(el('h2', null, 'Settings'));
      const row = (title, small, control) => {
        const l = el('label');
        const s = el('span', null, title);
        if (small) s.appendChild(el('small', null, small));
        l.append(s, control);
        d.appendChild(l);
      };
      const select = (key, options, after) => {
        const s = el('select');
        for (const [v, name] of options) { const o = el('option', null, name); o.value = v; s.appendChild(o); }
        s.value = settings[key];
        s.onchange = async () => { settings[key] = s.value; await saveSettings(); if (after) after(); };
        return s;
      };
      const check = (key, after) => {
        const c = el('input'); c.type = 'checkbox'; c.checked = !!settings[key];
        c.onchange = async () => { settings[key] = c.checked; await saveSettings(); if (after) after(); };
        return c;
      };
      row('Theme', null, select('theme', [['nebula', 'Nebula'], ['horizon', 'Event Horizon (pure black)'], ['supernova', 'Supernova'], ['aurora', 'Aurora']], applyTheme));
      row('Search engine', null, select('search', Object.entries(ENGINES).map(([k, v]) => [k, v[0]])));
      const cs = el('input'); cs.value = settings.customSearch; cs.placeholder = 'https://example.com/?q=%s';
      cs.onchange = async () => { settings.customSearch = cs.value.trim(); await saveSettings(); };
      row('Custom search address', 'Used when the engine is "Custom address"; %s is replaced by your words', cs);
      row('Search shortcuts', '!gh, !w, !aw (Wayback Machine), !yt, !so, !mdn, !crates …', check('bangs'));
      row('Shortcuts without the !', '"gh rust" works too (2+ letter keywords)', check('bangsBare'));
      row('HTTPS-only', 'Upgrade plain-HTTP links to HTTPS', check('httpsOnly', () => invoke('set_https_only', { on: settings.httpsOnly })));
      row('Still starfield', 'No animation on the start page', check('still'));
      const upd = el('button', null, 'Update now');
      upd.onclick = updateLists;
      row('Shield filter lists', settings.listsUpdated ? 'Updated ' + new Date(settings.listsUpdated).toLocaleDateString() : 'Built-in list only. Downloads the StevenBlack hosts list.', upd);
      const nm = el('input'); nm.value = StationLink.name;
      nm.onchange = () => StationLink.rename(nm.value.trim());
      row('Name shown to linked phones', null, nm);
      const about = el('p', 'dim');
      invoke('app_version').then((v) => { about.textContent = `Deep Stellar Station ${v} · free & open source · no history, no telemetry. Links with Deep Stellar Browsing on Android.`; });
      d.appendChild(about);
      const a = el('div', 'actions');
      const done = el('button', 'primary', 'Done');
      done.onclick = closeDialog;
      a.appendChild(done);
      d.appendChild(a);
    });
  }

  async function updateLists() {
    toast('Downloading filter list…');
    try {
      const r = await fetch('https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const n = await invoke('shield_lists', { text: await r.text() });
      settings.listsUpdated = Date.now();
      await saveSettings();
      toast(`Shield updated: ${n.toLocaleString()} domains`);
    } catch (e) { toast('Couldn\'t update the list: ' + (e.message || e)); }
  }

  function applyTheme() {
    window.dsApplyTheme(settings.theme);
    // Reload open start pages so they pick up the new colours.
    for (const t of tabs) if (isStart(t.url)) invoke('tab_navigate', { label: t.label, url: startUrl() });
  }

  // ---------------------------------------------------------------- start
  async function boot() {
    settings = Object.assign({}, DEFAULTS, await load('settings', {}));
    bookmarks = await load('bookmarks', []);
    inbox.push(...(await load('inbox', [])));
    window.dsApplyTheme(settings.theme);
    $('#shield').classList.toggle('off', !settings.shield);
    await invoke('shield_set', { enabled: settings.shield });
    await invoke('set_https_only', { on: settings.httpsOnly });
    layout();
    await newTab();
    try { await StationLink.init(); } catch (e) { console.error(e); toast('Linking is unavailable: ' + (e.message || e)); }
    // Monthly list refresh, only if you've downloaded the lists before.
    if (settings.listsUpdated && Date.now() - settings.listsUpdated > 30 * 86400000) updateLists();
  }
  boot();
})();
