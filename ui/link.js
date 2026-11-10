/* Deep Stellar link protocol v1 (docs/LINK-PROTOCOL.md): pairing, keys, encryption, queue.
   Uses only the web engine's built-in WebCrypto. The Rust side just moves frames. */
(function () {
  'use strict';
  const T = window.__TAURI__;
  const invoke = T.core.invoke;
  const listen = T.event.listen;
  const subtle = crypto.subtle;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // ---------------------------------------------------------------- encodings
  function b64(bytes) {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
  async function fp(pubB64) { return b64(await subtle.digest('SHA-256', unb64(pubB64))).slice(0, 16); }
  async function hmac(keyBytes, text) {
    const k = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return b64(await subtle.sign('HMAC', k, enc.encode(text)));
  }
  function same(a, b) { // constant-time-ish string compare
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
  }

  // ---------------------------------------------------------------- state
  // link.json: { priv: JWK, pub, name, peers: { fp: {pub,name,added} }, queue: { fp: [{id,body}] }, seen: [ids] }
  let st = null;
  let myPriv = null;
  let myFp = '';
  const keys = {};        // peer fp -> AES key
  const connOf = {};      // peer fp -> conn id
  const peerOfConn = {};  // conn id -> peer fp
  let pairing = null;     // { token, until }
  let info = null;
  const handlers = { change: [], message: [], paired: [] };
  const emit = (ev, x) => handlers[ev].forEach((f) => { try { f(x); } catch (e) { console.error(e); } });

  async function save() { await invoke('store_set', { name: 'link', content: JSON.stringify(st) }); }

  async function deriveKey(peerPub) {
    const pk = await subtle.importKey('raw', unb64(peerPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const z = await subtle.deriveBits({ name: 'ECDH', public: pk }, myPriv, 256);
    const base = await subtle.importKey('raw', z, 'HKDF', false, ['deriveKey']);
    const info = [st.pub, peerPub].sort().join('|');
    return subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('deep-stellar-link-v1'), info: enc.encode(info) },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function init() {
    const raw = await invoke('store_get', { name: 'link' });
    st = raw ? JSON.parse(raw) : null;
    if (!st || !st.priv) {
      const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      st = {
        priv: await subtle.exportKey('jwk', kp.privateKey),
        pub: b64(await subtle.exportKey('raw', kp.publicKey)),
        name: await invoke('computer_name'),
        peers: {}, queue: {}, seen: [],
      };
      await save();
    }
    st.peers = st.peers || {}; st.queue = st.queue || {}; st.seen = st.seen || [];
    myPriv = await subtle.importKey('jwk', st.priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    myFp = await fp(st.pub);
    for (const f of Object.keys(st.peers)) keys[f] = await deriveKey(st.peers[f].pub);

    await listen('link://frame', (e) => onFrame(e.payload.conn, e.payload.data).catch(console.error));
    await listen('link://closed', (e) => {
      const f = peerOfConn[e.payload];
      delete peerOfConn[e.payload];
      if (f && connOf[f] === e.payload) { delete connOf[f]; emit('change'); }
    });
    try {
      info = await invoke('link_start', { fp: myFp, name: st.name });
    } catch (e) {
      console.warn('link_start failed', e);
    }
    emit('change');
  }

  async function send(conn, obj) {
    try { await invoke('link_send', { conn, data: JSON.stringify(obj) }); return true; } catch (e) { return false; }
  }

  // ---------------------------------------------------------------- incoming
  async function onFrame(conn, data) {
    let f;
    try { f = JSON.parse(data); } catch (e) { return; }
    if (f.t === 'pair') return onPair(conn, f);
    if (f.t === 'hello') {
      if (!st.peers[f.fp]) { await send(conn, { t: 'unknown' }); invoke('link_close', { conn }); return; }
      connOf[f.fp] = conn; peerOfConn[conn] = f.fp;
      if (f.name && f.name !== st.peers[f.fp].name) { st.peers[f.fp].name = String(f.name).slice(0, 60); save(); }
      await send(conn, { t: 'hello', fp: myFp, name: st.name });
      await flush(f.fp);
      emit('change');
      return;
    }
    if (f.t === 'msg') return onMsg(conn, f);
  }

  async function onPair(conn, f) {
    const fail = async (why) => { await send(conn, { t: 'pair-fail', why }); invoke('link_close', { conn }); };
    if (!pairing || Date.now() > pairing.until) return fail('This code has expired. Show a new one on the computer.');
    if (f.v !== 1 || typeof f.pub !== 'string' || typeof f.proof !== 'string') return fail('Unsupported version');
    const want = await hmac(pairing.token, 'dsl-pair-1|' + f.pub + '|' + st.pub);
    if (!same(want, f.proof)) return fail('Wrong code');
    let key;
    try { key = await deriveKey(f.pub); } catch (e) { return fail('Bad key'); }
    const pfp = await fp(f.pub);
    const token = pairing.token;
    pairing = null; // single use
    st.peers[pfp] = { pub: f.pub, name: String(f.name || 'Phone').slice(0, 60), added: Date.now() };
    keys[pfp] = key;
    await save();
    connOf[pfp] = conn; peerOfConn[conn] = pfp;
    await send(conn, { t: 'paired', pub: st.pub, name: st.name, proof: await hmac(token, 'dsl-paired-1|' + st.pub + '|' + f.pub) });
    emit('paired', { fp: pfp, name: st.peers[pfp].name });
    emit('change');
  }

  async function onMsg(conn, f) {
    const key = keys[f.fp];
    if (!key || peerOfConn[conn] !== f.fp) return;
    let body;
    try {
      const plain = await subtle.decrypt(
        { name: 'AES-GCM', iv: unb64(f.n), additionalData: enc.encode('dsl-msg-1|' + f.fp) }, key, unb64(f.c));
      body = JSON.parse(dec.decode(plain));
    } catch (e) { return; } // not from this peer, or altered: dropped
    if (!body || typeof body.id !== 'string') return;
    if (body.kind === 'ack') {
      const q = st.queue[f.fp] || [];
      st.queue[f.fp] = q.filter((m) => m.id !== body.ack);
      await save();
      emit('change');
      return;
    }
    // Acknowledge even repeats, so the phone stops resending.
    await sendBody(f.fp, { kind: 'ack', ack: body.id }, false);
    if (st.seen.includes(body.id)) return;
    st.seen.push(body.id);
    if (st.seen.length > 500) st.seen = st.seen.slice(-500);
    await save();
    emit('message', {
      id: body.id, ts: Number(body.ts) || Date.now(), kind: body.kind,
      url: typeof body.url === 'string' ? body.url : '', title: typeof body.title === 'string' ? body.title : '',
      text: typeof body.text === 'string' ? body.text : '',
      from: st.peers[f.fp].name, fp: f.fp, dir: 'in',
    });
  }

  // ---------------------------------------------------------------- outgoing
  async function seal(peerFp, body) {
    const n = rand(12);
    const c = await subtle.encrypt(
      { name: 'AES-GCM', iv: n, additionalData: enc.encode('dsl-msg-1|' + myFp) }, keys[peerFp], enc.encode(JSON.stringify(body)));
    return { t: 'msg', fp: myFp, n: b64(n), c: b64(c) };
  }

  /** Queued messages are re-sent until acknowledged; acks themselves aren't queued. */
  async function sendBody(peerFp, partial, queue = true) {
    const body = Object.assign({ id: b64(rand(12)), ts: Date.now(), from: st.name }, partial);
    if (queue) {
      (st.queue[peerFp] = st.queue[peerFp] || []).push({ id: body.id, body });
      if (st.queue[peerFp].length > 200) st.queue[peerFp] = st.queue[peerFp].slice(-200);
      await save();
    }
    const conn = connOf[peerFp];
    if (conn != null) await send(conn, await seal(peerFp, body));
    return body;
  }

  async function flush(peerFp) {
    const conn = connOf[peerFp];
    if (conn == null) return;
    for (const m of st.queue[peerFp] || []) await send(conn, await seal(peerFp, m.body));
  }

  // ---------------------------------------------------------------- public API
  window.StationLink = {
    init,
    on(ev, f) { handlers[ev].push(f); },
    get name() { return st ? st.name : ''; },
    get fingerprint() { return myFp; },
    peers() {
      return Object.keys(st ? st.peers : {}).map((f) => ({
        fp: f, name: st.peers[f].name, added: st.peers[f].added, online: connOf[f] != null,
        pending: (st.queue[f] || []).length,
      }));
    },
    /** Starts pairing; returns the QR text (valid 10 minutes, single use). */
    async newPairing() {
      info = await invoke('link_info') || info;
      if (!info) throw new Error('Linking is unavailable: the network port could not be opened.');
      pairing = { token: rand(16), until: Date.now() + 10 * 60 * 1000 };
      const q = new URLSearchParams({ v: '1', k: st.pub, t: b64(pairing.token), a: info.addrs.join(','), n: st.name });
      return 'dsstation://pair?' + q.toString();
    },
    cancelPairing() { pairing = null; },
    get networkInfo() { return info; },
    async sendLink(peerFp, url, title) { return sendBody(peerFp, { kind: 'link', url, title: title || '' }); },
    async sendText(peerFp, text) { return sendBody(peerFp, { kind: 'text', text }); },
    async rename(name) { st.name = String(name).slice(0, 60) || st.name; await save(); emit('change'); },
    async unpair(peerFp) {
      delete st.peers[peerFp]; delete st.queue[peerFp]; delete keys[peerFp];
      const conn = connOf[peerFp];
      if (conn != null) { invoke('link_close', { conn }); delete connOf[peerFp]; }
      await save(); emit('change');
    },
  };
})();
