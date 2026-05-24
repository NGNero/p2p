/* DropZone — Main App JS */
'use strict';

// ============================================================
// CONFIG
// ============================================================
const CONFIG = Object.freeze({
  MAX_FILES: 50,
  MAX_FILE_SIZE: 2 * 1024 * 1024 * 1024,
  MAX_TOTAL_SIZE: 5 * 1024 * 1024 * 1024,
  MAX_RETRIES: 5,
  CHUNK_TIMEOUT: 4000,
  INITIAL_CHUNK_SIZE: 32 * 1024,
  MIN_CHUNK_SIZE: 4 * 1024,
  MAX_CHUNK_SIZE: 256 * 1024,
  INITIAL_WINDOW: 8,
  MIN_WINDOW: 2,
  MAX_WINDOW: 20,
  RTT_HISTORY: 12,
  SPEED_UPDATE_INTERVAL: 900,
  PEER_KEY_RE: /^[a-zA-Z0-9_-]{1,64}$/,
});

// ============================================================
// DOM HELPERS
// ============================================================
const $ = (id) => document.getElementById(id);
const el = (tag, cls, attrs = {}, children = []) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') e.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else e.setAttribute(k, String(v));
  }
  for (const c of children) { if (c) e.appendChild(c); }
  return e;
};

// ============================================================
// SETTINGS STORE
// ============================================================
class SettingsStore {
  static KEYS = { security: 'standard', chunkMode: 'adaptive', autoDownload: false };
  static load() {
    return {
      security: localStorage.getItem('dz_security') || 'standard',
      chunkMode: localStorage.getItem('dz_chunkMode') || 'adaptive',
      autoDownload: localStorage.getItem('dz_autoDownload') === 'true',
    };
  }
  static save(key, value) {
    try { localStorage.setItem(`dz_${key}`, String(value)); } catch {}
  }
  static reset() {
    for (const k of Object.keys(SettingsStore.KEYS)) {
      try { localStorage.removeItem(`dz_${k}`); } catch {}
    }
  }
}

// ============================================================
// CRYPTO MANAGER
// ============================================================
class CryptoManager {
  static async generateKey() {
    return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }
  static async exportKey(key) {
    const raw = await crypto.subtle.exportKey('raw', key);
    return btoa(String.fromCharCode(...new Uint8Array(raw)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }
  static async importKey(b64) {
    let s = b64.replace(/-/g, '+').replace(/_/g, '/');
    const pad = s.length % 4;
    if (pad) s += '='.repeat(4 - pad);
    const binary = atob(s);
    const raw = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }
  static async encryptBuffer(buffer, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
    const out = new Uint8Array(12 + ct.byteLength);
    out.set(iv);
    out.set(new Uint8Array(ct), 12);
    return out.buffer;
  }
  static async decryptBuffer(buffer, key) {
    const view = new Uint8Array(buffer);
    const iv = view.slice(0, 12);
    const data = view.slice(12);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  }
}

// ============================================================
// TOAST
// ============================================================
class Toast {
  static show(msg, type = 'info') {
    const c = $('toast-container');
    const icons = {
      info: 'ph-info',
      success: 'ph-check-circle',
      error: 'ph-warning-circle',
      warning: 'ph-warning',
    };
    const t = el('div', `toast toast-${type}`, { role: 'alert', 'aria-live': 'assertive' }, [
      el('i', icons[type] || 'ph-info', { 'aria-hidden': 'true' }),
      el('span', '', { text: msg }),
    ]);
    c.appendChild(t);
    const hide = () => {
      t.classList.add('is-hiding');
      setTimeout(() => t.remove(), 250);
    };
    setTimeout(hide, 4000);
  }
}

// ============================================================
// FORMAT UTILS
// ============================================================
function fmtBytes(b) {
  if (!b || b === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(k)), sizes.length - 1);
  return parseFloat((b / k ** i).toFixed(2)) + '\u202f' + sizes[i];
}
function fmtDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return Math.floor(ms / 1000) + 's';
  return Math.floor(ms / 60000) + 'm\u202f' + Math.floor((ms % 60000) / 1000) + 's';
}
function fileIconType(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    image: ['jpg','jpeg','png','gif','webp','svg','bmp','ico','avif'],
    video: ['mp4','webm','mov','avi','mkv','flv'],
    audio: ['mp3','wav','ogg','flac','aac','opus','m4a'],
    document: ['pdf','doc','docx','txt','rtf','odt','xls','xlsx','ppt','pptx','csv','md'],
    archive: ['zip','rar','7z','tar','gz','bz2','xz'],
    code: ['js','ts','jsx','tsx','html','css','py','java','cpp','c','go','rs','php','rb','json','yaml','xml','sh'],
  };
  for (const [t, exts] of Object.entries(map)) if (exts.includes(ext)) return t;
  return 'file';
}
function phIcon(type) {
  return {
    image: 'ph-image', video: 'ph-video-camera', audio: 'ph-headphones',
    document: 'ph-file-text', archive: 'ph-archive', code: 'ph-code', file: 'ph-file'
  }[type] || 'ph-file';
}
function sanitizeFilename(name) {
  return name.replace(/[/\\?%*:|"<>]/g, '_') || 'download';
}

// ============================================================
// CHUNKED SENDER
// ============================================================
class ChunkedSender {
  constructor(item, conn, cryptoKey, onProgress, onDone, onError, onRetry, onChunkSent) {
    this.item = item; this.conn = conn; this.key = cryptoKey;
    this.onProgress = onProgress; this.onDone = onDone;
    this.onError = onError; this.onRetry = onRetry; this.onChunkSent = onChunkSent;
    this.chunkSize = item.fixedChunk || CONFIG.INITIAL_CHUNK_SIZE;
    this.windowSize = CONFIG.INITIAL_WINDOW;
    this.inFlight = new Map();
    this.nextSeq = 0; this.offset = 0;
    this.total = item.size; this.acked = 0;
    this.retries = 0; this.rtts = [];
    this.timer = null; this.paused = false;
    this.cancelled = false; this.done = false;
    this._filling = false;
    if (item.content) this.textBuf = new TextEncoder().encode(item.content);
  }
  start() {
    this.conn.send({
      type: 'file-header', id: this.item.id,
      name: sanitizeFilename(this.item.name),
      size: this.total, filetype: this.item.type,
      isText: !!this.item.content
    });
  }
  onAckHeader() {
    this.fillWindow();
    this.timer = setInterval(() => this.checkTimeouts(), 600);
  }
  async fillWindow() {
    if (this._filling || this.paused || this.cancelled || this.done) return;
    this._filling = true;
    try {
      while (this.inFlight.size < this.windowSize && this.offset < this.total) {
        if (!this.conn.open) break;
        const end = Math.min(this.offset + this.chunkSize, this.total);
        let buf;
        if (this.textBuf) {
          buf = this.textBuf.slice(this.offset, end).buffer;
        } else {
          buf = await this.readSlice(this.item.file.slice(this.offset, end));
        }
        let payload = buf;
        if (this.key) payload = await CryptoManager.encryptBuffer(buf, this.key);
        const seq = this.nextSeq++;
        this.conn.send({ type: 'chunk', id: this.item.id, seq, data: payload, encrypted: !!this.key });
        this.inFlight.set(seq, { payload, time: performance.now(), retries: 0 });
        this.offset = end;
        if (this.onChunkSent) this.onChunkSent();
      }
      if (this.inFlight.size === 0 && this.offset >= this.total) this.finish();
    } catch (e) {
      if (!this.cancelled) this.onError('Read/encrypt error: ' + e.message);
    }
    this._filling = false;
  }
  readSlice(slice) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = (e) => res(e.target.result);
      r.onerror = () => rej(new Error('FileReader error'));
      r.readAsArrayBuffer(slice);
    });
  }
  onAck(seq) {
    const pkt = this.inFlight.get(seq);
    if (!pkt) return;
    this.inFlight.delete(seq);
    this.acked++;
    this.rtts.push(performance.now() - pkt.time);
    if (this.rtts.length > CONFIG.RTT_HISTORY) this.rtts.shift();
    if (!this.item.fixedChunk) this.adapt();
    this.onProgress(this.offset, this.total);
    this.fillWindow();
  }
  adapt() {
    if (this.rtts.length < 3) return;
    const avg = this.rtts.reduce((a, b) => a + b, 0) / this.rtts.length;
    if (avg < 80 && this.retries === 0) {
      this.chunkSize = Math.min(Math.floor(this.chunkSize * 1.2), CONFIG.MAX_CHUNK_SIZE);
      this.windowSize = Math.min(this.windowSize + 1, CONFIG.MAX_WINDOW);
    } else if (avg > 300 || this.retries > 0) {
      this.chunkSize = Math.max(Math.floor(this.chunkSize * 0.8), CONFIG.MIN_CHUNK_SIZE);
      this.windowSize = Math.max(this.windowSize - 1, CONFIG.MIN_WINDOW);
      this.retries = 0;
    }
  }
  checkTimeouts() {
    const now = performance.now();
    for (const [seq, pkt] of this.inFlight) {
      if (now - pkt.time > CONFIG.CHUNK_TIMEOUT) {
        if (pkt.retries >= CONFIG.MAX_RETRIES) {
          this.onError(`Chunk ${seq} failed after ${CONFIG.MAX_RETRIES} retries — connection may be unstable.`);
          return;
        }
        pkt.retries++; this.retries++;
        pkt.time = now;
        if (this.conn.open) this.conn.send({ type: 'chunk', id: this.item.id, seq, data: pkt.payload, encrypted: !!this.key });
        if (this.onRetry) this.onRetry(this.retries);
      }
    }
  }
  pause() { this.paused = true; }
  resume() { this.paused = false; this.fillWindow(); }
  cancel() { this.cancelled = true; clearInterval(this.timer); this.inFlight.clear(); }
  finish() {
    if (this.done) return;
    this.done = true;
    clearInterval(this.timer);
    this.conn.send({ type: 'file-done', id: this.item.id });
    this.onDone();
  }
}

// ============================================================
// CHUNKED RECEIVER
// ============================================================
class ChunkedReceiver {
  constructor(item, conn, cryptoKey, onProgress, onDone) {
    this.item = item; this.conn = conn; this.key = cryptoKey;
    this.onProgress = onProgress; this.onDone = onDone;
    this.expectedSeq = 0; this.buffer = new Map();
    this.receivedBytes = 0;
    this.textChunks = []; this.blobChunks = [];
    this.complete = false; this.chunkQueue = []; this.processing = false;
  }
  async start() {
    this.conn.send({ type: 'ack-header', id: this.item.id });
  }
  onChunk(seq, data, encrypted) {
    this.chunkQueue.push({ seq, data, encrypted });
    if (!this.processing) this._drain();
  }
  async _drain() {
    this.processing = true;
    while (this.chunkQueue.length > 0) {
      const task = this.chunkQueue.shift();
      try { await this._processChunk(task.seq, task.data, task.encrypted); }
      catch (e) { console.error('[Receiver] chunk error', e); }
    }
    this.processing = false;
  }
  async _processChunk(seq, data, encrypted) {
    if (this.complete) return;
    let payload = data;
    if (encrypted && this.key) {
      try { payload = await CryptoManager.decryptBuffer(data, this.key); }
      catch {
        this.conn.send({ type: 'chunk-error', id: this.item.id, seq, message: 'Decrypt failed' });
        return;
      }
    }
    if (seq < this.expectedSeq) {
      this.conn.send({ type: 'ack-chunk', id: this.item.id, seq });
      return;
    }
    if (seq === this.expectedSeq) {
      await this._write(payload);
      this.expectedSeq++;
      while (this.buffer.has(this.expectedSeq)) {
        await this._write(this.buffer.get(this.expectedSeq));
        this.buffer.delete(this.expectedSeq);
        this.expectedSeq++;
      }
    } else if (seq < this.expectedSeq + CONFIG.MAX_WINDOW * 3) {
      this.buffer.set(seq, payload);
    }
    this.conn.send({ type: 'ack-chunk', id: this.item.id, seq });
    this.onProgress(this.receivedBytes, this.item.size);
    if (this.receivedBytes >= this.item.size && this.buffer.size === 0) this._finish();
  }
  async _write(buf) {
    this.receivedBytes += buf.byteLength;
    if (this.item.isText) {
      this.textChunks.push(buf);
    } else {
      this.blobChunks.push(new Uint8Array(buf));
    }
  }
  _finish() {
    if (this.complete) return;
    this.complete = true;
    if (this.item.isText) {
      const dec = new TextDecoder();
      this.item.textContent = this.textChunks.map(c => dec.decode(c)).join('');
    } else {
      const blob = new Blob(this.blobChunks, { type: this.item.type || 'application/octet-stream' });
      this.item.downloadUrl = URL.createObjectURL(blob);
    }
    this.conn.send({ type: 'ack-file-done', id: this.item.id });
    this.onDone();
  }
}

// ============================================================
// TRANSFER MANAGER
// ============================================================
class TransferManager {
  constructor() { this._reset(); }
  _reset() {
    this.queue = []; this.currentIdx = 0;
    this.isPaused = false; this.isCancelled = false;
    this.senders = new Map(); this.receivers = new Map();
    this.conn = null; this.key = null;
    this.stats = { start: 0, lastUpdate: 0, bytesSince: 0, total: 0, sent: 0, retries: 0, chunks: 0 };
  }
  initSender(files, conn, cryptoKey, settings) {
    this._reset();
    this.conn = conn; this.key = cryptoKey;
    this.queue = files.map((f, i) => ({
      id: f.id || `f${i}-${Date.now()}`,
      file: f.file || null, content: f.content || null,
      name: sanitizeFilename(f.name), size: f.size,
      type: f.type || 'application/octet-stream',
      fixedChunk: settings.chunkMode !== 'adaptive' ? parseInt(settings.chunkMode) * 1024 : null,
      sent: 0, _last: 0, status: 'pending',
    }));
    this.stats.total = this.queue.reduce((s, q) => s + q.size, 0);
    this.stats.start = this.stats.lastUpdate = performance.now();
    this.renderQueue(); this.updateMaster();
    conn.send({ type: 'manifest', files: this.queue.map(q => ({ id: q.id, name: q.name, size: q.size, filetype: q.type, isText: !!q.content })) });
  }
  initReceiver(manifest, conn, cryptoKey) {
    this._reset();
    this.conn = conn; this.key = cryptoKey;
    this.queue = manifest.map(f => ({
      id: f.id, name: sanitizeFilename(f.name), size: f.size,
      type: f.filetype || 'application/octet-stream',
      isText: f.isText, sent: 0, _last: 0, status: 'pending',
      downloadUrl: null, textContent: '',
    }));
    this.stats.total = this.queue.reduce((s, q) => s + q.size, 0);
    this.stats.start = this.stats.lastUpdate = performance.now();
    this.renderQueue(); this.updateMaster();
  }
  onAckManifest() { this.startNextFile(); }
  startNextFile() {
    if (this.isCancelled) return;
    const next = this.queue.find(q => q.status === 'pending');
    if (!next) return;
    next.status = 'active';
    this.currentIdx = this.queue.indexOf(next);
    this.renderQueue();
    const sender = new ChunkedSender(next, this.conn, this.key,
      (offset) => {
        next.sent = offset;
        this.stats.sent = this.queue.reduce((s, q) => s + q.sent, 0);
        this.stats.bytesSince += offset - next._last;
        next._last = offset;
        this.updateMaster(); this.renderQueue();
      },
      () => {
        next.status = 'complete'; this.renderQueue();
        if (this.queue.every(q => q.status === 'complete')) this.onAllDone();
        else this.startNextFile();
      },
      (err) => App.showError('Transfer failed', err),
      (retries) => {
        this.stats.retries++;
        const rd = $('retry-display');
        if (rd) rd.textContent = String(this.stats.retries);
      },
      () => {
        this.stats.chunks++;
        const cd = $('chunk-display');
        if (cd) cd.textContent = String(this.stats.chunks);
      }
    );
    this.senders.set(next.id, sender);
    sender.start();
  }
  onAckHeader(id) { const s = this.senders.get(id); if (s) s.onAckHeader(); }
  onFileHeader(id) {
    const item = this.queue.find(q => q.id === id);
    if (!item) return;
    item.status = 'active';
    this.currentIdx = this.queue.indexOf(item);
    const receiver = new ChunkedReceiver(item, this.conn, this.key,
      (recv) => {
        item.sent = recv;
        this.stats.sent = this.queue.reduce((s, q) => s + q.sent, 0);
        this.stats.bytesSince += recv - item._last;
        item._last = recv;
        this.updateMaster(); this.renderQueue();
      },
      () => {
        item.status = 'complete'; this.renderQueue();
        if (this.queue.every(q => q.status === 'complete')) this.onAllDone();
      }
    );
    this.receivers.set(id, receiver);
    receiver.start();
  }
  onChunk(id, seq, data, encrypted) {
    const rec = this.receivers.get(id);
    if (rec) rec.onChunk(seq, data, encrypted);
  }
  onAckChunk(id, seq) { const s = this.senders.get(id); if (s) s.onAck(seq); }
  onFileDone(id) { const r = this.receivers.get(id); if (r) r._finish(); }
  onAllDone() { App.showDone(this.stats); }
  pause() {
    this.isPaused = !this.isPaused;
    this.senders.forEach(s => this.isPaused ? s.pause() : s.resume());
    const pt = $('pause-text'), pi = $('pause-icon'), pb = $('pause-btn');
    if (pt) pt.textContent = this.isPaused ? 'Resume' : 'Pause';
    if (pi) pi.className = this.isPaused ? 'ph ph-play' : 'ph ph-pause';
    if (pb) pb.setAttribute('aria-pressed', String(this.isPaused));
  }
  cancel() {
    this.isCancelled = true;
    this.senders.forEach(s => s.cancel());
    if (this.conn?.open) this.conn.send({ type: 'cancel' });
  }
  updateMaster() {
    const pct = this.stats.total > 0 ? Math.round(this.stats.sent / this.stats.total * 100) : 0;
    const mp = $('master-progress'), pw = $('progress-wrapper');
    const mpct = $('master-percent'), mb = $('master-bytes'), qs = $('queue-status');
    if (mp) mp.style.width = pct + '%';
    if (pw) pw.setAttribute('aria-valuenow', String(pct));
    if (mpct) mpct.textContent = pct + '%';
    if (mb) mb.textContent = `${fmtBytes(this.stats.sent)} / ${fmtBytes(this.stats.total)}`;
    const done = this.queue.filter(q => q.status === 'complete').length;
    if (qs) qs.textContent = `${done} / ${this.queue.length}`;
    const now = performance.now();
    if (now - this.stats.lastUpdate > CONFIG.SPEED_UPDATE_INTERVAL) {
      const elapsed = (now - this.stats.lastUpdate) / 1000;
      const speed = this.stats.bytesSince / elapsed;
      const ts = $('transfer-speed'), te = $('transfer-eta');
      if (speed > 0) {
        if (ts) ts.textContent = (speed / 1048576).toFixed(1) + ' MB/s';
        if (te) {
          const rem = this.stats.total - this.stats.sent;
          te.textContent = rem > 0 ? fmtDuration(Math.round(rem / speed) * 1000) + ' left' : 'Finishing…';
        }
      }
      this.stats.lastUpdate = now;
      this.stats.bytesSince = 0;
    }
  }
  renderQueue() {
    const container = $('transfer-queue');
    if (!container) return;
    container.innerHTML = '';
    this.queue.forEach((item, idx) => {
      const isActive = idx === this.currentIdx && item.status === 'active';
      const pct = item.size > 0 ? Math.round(item.sent / item.size * 100) : 0;
      const icon = phIcon(fileIconType(item.name));
      const row = el('div', `queue-item ${isActive ? 'is-active' : ''}`, { role: 'listitem' }, [
        el('div', 'queue-icon', {}, [el('i', icon, { 'aria-hidden': 'true' })]),
        el('div', 'queue-info', {}, [
          el('div', 'queue-name', { text: item.name }),
          el('div', 'queue-bar-wrap', {}, [
            el('div', 'queue-bar', { style: { width: pct + '%' } }),
          ]),
          el('div', 'queue-meta', {}, [
            el('span', '', { text: fmtBytes(item.sent) }),
            el('span', '', { text: pct + '%' }),
          ]),
        ]),
      ]);
      container.appendChild(row);
    });
  }
}

// ============================================================
// PEER MANAGER
// ============================================================
class PeerManager {
  constructor(transferManager, onStatus, onError) {
    this.transfer = transferManager;
    this.onStatus = onStatus; this.onError = onError;
    this.peer = null; this.conn = null;
    this.isReceiver = false; this.connectToId = null;
    this.cryptoKey = null; this.pendingShare = null;
  }
  async init() {
    const params = new URLSearchParams(window.location.search);
    const rawId = params.get('peer') || '';
    this.connectToId = CONFIG.PEER_KEY_RE.test(rawId) ? rawId : null;
    const hash = window.location.hash.slice(1);
    this.isReceiver = !!this.connectToId;
    if (hash) {
      try { this.cryptoKey = await CryptoManager.importKey(hash); }
      catch { console.warn('[Crypto] Bad key in URL hash'); }
    }
    this.peer = new Peer({ debug: 0, config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ]
    }});
    this.peer.on('open', () => {
      this.onStatus('Ready', 'success');
      App.switchPanel(this.isReceiver ? 'receive' : 'send');
      if (this.isReceiver) this.startReceiver();
    });
    this.peer.on('connection', (conn) => {
      if (this.conn) { conn.close(); return; }
      this.conn = conn;
      this._setupConn(conn, false);
    });
    this.peer.on('error', (err) => {
      this.onStatus('Error', 'danger');
      const map = {
        'peer-unavailable': ['Peer unavailable', 'The sender is offline or this link has expired.'],
        'network': ['Network error', 'Cannot reach the signaling server.'],
        'server-error': ['Server error', 'Signaling server error. Try again later.'],
        'disconnected': ['Disconnected', 'Connection closed unexpectedly.'],
        'unavailable-id': ['ID conflict', 'Your Peer ID is already in use.'],
      };
      const [title, msg] = map[err.type] || ['Error', err.message || 'Unknown error'];
      this.onError(title, msg);
    });
    this.peer.on('disconnected', () => {
      this.onStatus('Offline', 'danger');
      if (!this.peer.destroyed) setTimeout(() => this.peer.reconnect(), 2000);
    });
  }
  async prepareShare(files, settings) {
    if (settings.security === 'aes' && !this.cryptoKey) {
      const key = await CryptoManager.generateKey();
      this.cryptoKey = key;
      const exported = await CryptoManager.exportKey(key);
      history.replaceState(null, '', window.location.pathname + window.location.search + '#' + exported);
    } else if (settings.security === 'standard') {
      this.cryptoKey = null;
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    const base = window.location.origin + window.location.pathname;
    const hash = settings.security === 'aes' ? '#' + window.location.hash.slice(1) : '';
    const shareUrl = `${base}?peer=${this.peer.id}${hash}`;
    const shareKey = window.location.hash.slice(1);

    try {
      new QRious({ element: $('qrcode'), value: shareUrl, size: 200, level: 'H', foreground: '#0a0a0b', background: '#ffffff' });
    } catch (e) { console.warn('QR failed', e); }

    const urlInput = $('share-url');
    const keyInput = $('share-key');
    const keyRow = $('key-row');
    if (urlInput) urlInput.value = shareUrl;
    if (keyInput) keyInput.value = shareKey || '';
    if (keyRow) keyRow.hidden = !shareKey;

    const badge = $('security-badge-text');
    if (badge) badge.textContent = settings.security === 'aes' ? 'AES-256-GCM' : 'Standard WebRTC';

    $('share-view').hidden = false;
    $('view-files').hidden = true;
    $('view-text').hidden = true;
    $('file-list-container').hidden = true;

    if (this.conn?.open) {
      this.transfer.initSender(files, this.conn, this.cryptoKey, settings);
    } else {
      this.pendingShare = { files, settings };
    }
  }
  startReceiver() {
    const conn = this.peer.connect(this.connectToId, { reliable: true, serialization: 'binary', metadata: { version: '2.2' } });
    this.conn = conn;
    this._setupConn(conn, true);
    const rs = $('receive-status');
    if (rs) { rs.hidden = false; }
    const rst = $('receive-status-text');
    if (rst) rst.textContent = 'Connecting to sender…';
  }
  connectWithKey(input, keyStr) {
    let peerId = input;
    let key = keyStr;
    try {
      const u = new URL(input);
      const p = u.searchParams.get('peer');
      if (p) peerId = p;
      if (u.hash.length > 1 && !key) key = u.hash.slice(1);
    } catch {
      const hashIdx = input.indexOf('#');
      if (hashIdx > -1 && !key) {
        key = input.slice(hashIdx + 1);
        peerId = input.slice(0, hashIdx);
      }
    }
    peerId = (peerId || '').trim();
    key = (key || '').trim();
    if (!CONFIG.PEER_KEY_RE.test(peerId)) { Toast.show('Invalid peer ID format', 'error'); return; }
    this.connectToId = peerId;
    if (key) {
      CryptoManager.importKey(key).then(k => {
        this.cryptoKey = k;
        history.replaceState(null, '', `?peer=${peerId}#${key}`);
        this.startReceiver();
      }).catch(() => Toast.show('Invalid encryption key', 'error'));
    } else {
      history.replaceState(null, '', `?peer=${peerId}`);
      this.startReceiver();
    }
  }
  _setupConn(conn, isReceiver) {
    let timeout = setTimeout(() => {
      if (!conn.open) this.onError('Timeout', 'Could not connect within 30s. The sender may be behind a restrictive firewall.');
    }, 30000);
    conn.on('open', () => {
      clearTimeout(timeout);
      this.onStatus('Connected', 'success');
      App.showTransfer();
      if (isReceiver) {
        const ts = $('transfer-title'), tst = $('transfer-subtitle');
        if (ts) ts.textContent = 'Receiving';
        if (tst) tst.textContent = 'Secure channel open';
      } else if (this.pendingShare) {
        this.transfer.initSender(this.pendingShare.files, conn, this.cryptoKey, this.pendingShare.settings);
        this.pendingShare = null;
        const ts = $('transfer-title'), tst = $('transfer-subtitle');
        if (ts) ts.textContent = 'Sending';
        if (tst) tst.textContent = `${this.transfer.queue.length} item${this.transfer.queue.length !== 1 ? 's' : ''}`;
      }
    });
    conn.on('data', (data) => {
      if (!data || typeof data !== 'object') return;
      this._handleData(data, isReceiver);
    });
    conn.on('close', () => {
      this.onStatus('Closed', 'danger');
      const allDone = this.transfer.queue.length > 0 && this.transfer.queue.every(q => q.status === 'complete');
      if (!allDone && !this.transfer.isCancelled) {
        this.onError('Disconnected', 'Peer disconnected before the transfer finished.');
      }
    });
    conn.on('error', (err) => this.onError('Channel error', err.message || 'Unknown channel error'));
  }
  _handleData(data, isReceiver) {
    if (isReceiver) {
      switch (data.type) {
        case 'manifest':
          if (!Array.isArray(data.files)) return;
          this.transfer.initReceiver(data.files, this.conn, this.cryptoKey);
          { const ts = $('transfer-title'), tst = $('transfer-subtitle');
            if (ts) ts.textContent = 'Receiving';
            if (tst) tst.textContent = `${data.files.length} item${data.files.length !== 1 ? 's' : ''}`;
          }
          this.conn.send({ type: 'ack-manifest' });
          break;
        case 'file-header':
          this.transfer.onFileHeader(data.id);
          { const ts = $('transfer-title');
            if (ts) ts.textContent = `Receiving: ${data.name}`;
          }
          break;
        case 'chunk':
          if (data.data instanceof ArrayBuffer || ArrayBuffer.isView(data.data))
            this.transfer.onChunk(data.id, data.seq, data.data instanceof ArrayBuffer ? data.data : data.data.buffer, data.encrypted);
          break;
        case 'file-done':
          this.transfer.onFileDone(data.id); break;
        case 'cancel':
          this.onError('Cancelled', 'The sender cancelled the transfer.'); break;
      }
    } else {
      switch (data.type) {
        case 'ack-manifest':
          this.transfer.onAckManifest();
          { const ts = $('transfer-title'), tst = $('transfer-subtitle');
            if (ts) ts.textContent = 'Sending';
            if (tst) tst.textContent = `${this.transfer.queue.length} item${this.transfer.queue.length !== 1 ? 's' : ''}`;
          }
          break;
        case 'ack-header':
          this.transfer.onAckHeader(data.id); break;
        case 'ack-chunk':
          this.transfer.onAckChunk(data.id, data.seq); break;
        case 'cancel':
          this.onError('Cancelled', 'The receiver cancelled the transfer.'); break;
      }
    }
  }
}

// ============================================================
// APP CONTROLLER
// ============================================================
const App = {
  settings: null, transfer: null, peer: null, files: [],

  async init() {
    // Unregister old service workers to prevent stale SW from serving HTML
    if ('serviceWorker' in navigator) {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const reg of regs) await reg.unregister();
      } catch (e) { console.warn('SW unregister failed', e); }
    }

    if (!window.isSecureContext) {
      document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;padding:2rem;background:#09090b;color:#f87171;font-family:Inter,sans-serif;text-align:center;"><h1>HTTPS or localhost required</h1></div>';
      return;
    }
    if (!window.Peer) { Toast.show('PeerJS failed to load. Check your connection.', 'error'); return; }

    this.settings = SettingsStore.load();
    this.transfer = new TransferManager();
    this.peer = new PeerManager(this.transfer, this.updateStatus.bind(this), this.showError.bind(this));
    await this.peer.init();
    this._bindUI();
    this._applyTheme();
  },

  _applyTheme() {
    this.switchPanel(new URLSearchParams(window.location.search).get('peer') ? 'receive' : 'send');
  },

  _bindUI() {
    // Sidebar nav
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchPanel(btn.dataset.panel));
    });

    // Mobile hamburger
    const hamburger = $('hamburger');
    const sidebar = $('sidebar');
    const overlay = $('sidebar-overlay');
    if (hamburger && sidebar) {
      const toggle = () => {
        const open = sidebar.classList.toggle('is-open');
        hamburger.setAttribute('aria-expanded', String(open));
        overlay?.classList.toggle('is-visible', open);
        document.body.style.overflow = open ? 'hidden' : '';
      };
      hamburger.addEventListener('click', toggle);
      overlay?.addEventListener('click', toggle);
    }

    // Send tabs
    const setTab = (active) => {
      const isFiles = active === 'files';
      $('tab-files').classList.toggle('is-active', isFiles);
      $('tab-files').setAttribute('aria-selected', String(isFiles));
      $('tab-files').tabIndex = isFiles ? 0 : -1;
      $('tab-text').classList.toggle('is-active', !isFiles);
      $('tab-text').setAttribute('aria-selected', String(!isFiles));
      $('tab-text').tabIndex = !isFiles ? 0 : -1;
      $('view-files').hidden = !isFiles;
      $('view-text').hidden = isFiles;
    };
    $('tab-files').addEventListener('click', () => setTab('files'));
    $('tab-text').addEventListener('click', () => setTab('text'));
    setTab('files');

    // Dropzone
    const dz = $('dropzone'), fi = $('file-input');
    const cancelDefault = (e) => { e.preventDefault(); e.stopPropagation(); };
    dz.addEventListener('dragenter', cancelDefault);
    dz.addEventListener('dragover', (e) => { cancelDefault(e); dz.classList.add('is-dragging'); });
    dz.addEventListener('dragleave', (e) => { cancelDefault(e); if (!dz.contains(e.relatedTarget)) dz.classList.remove('is-dragging'); });
    dz.addEventListener('drop', (e) => {
      cancelDefault(e); dz.classList.remove('is-dragging');
      if (e.dataTransfer.files.length) this.addFiles(e.dataTransfer.files);
    });
    fi.addEventListener('change', (e) => { if (e.target.files.length) this.addFiles(e.target.files); fi.value = ''; });

    $('clear-files-btn').addEventListener('click', () => { this.files = []; this.renderFiles(); });
    $('confirm-files-btn').addEventListener('click', () => {
      if (!this.files.length) { Toast.show('Select at least one file', 'warning'); return; }
      this.peer.prepareShare(this.files.map(f => ({ file: f.file, name: f.name, size: f.size, type: f.type })), this.settings);
    });
    $('confirm-text-btn').addEventListener('click', () => {
      const text = $('text-input').value.trim();
      if (!text) { Toast.show('Enter some text to send', 'warning'); return; }
      const blob = new Blob([text], { type: 'text/plain' });
      this.files = [{ content: text, name: 'message.txt', size: blob.size, type: 'text/plain' }];
      this.peer.prepareShare(this.files, this.settings);
    });
    $('cancel-share-btn').addEventListener('click', () => {
      $('share-view').hidden = true;
      if (this.files[0]?.content) $('view-text').hidden = false;
      else $('view-files').hidden = false;
    });

    // Copy buttons
    $('copy-link-btn')?.addEventListener('click', () => {
      const val = $('share-url')?.value;
      if (val) navigator.clipboard.writeText(val).then(() => Toast.show('Link copied!', 'success')).catch(() => Toast.show('Copy failed', 'warning'));
    });
    $('copy-key-btn')?.addEventListener('click', () => {
      const val = $('share-key')?.value;
      if (val) navigator.clipboard.writeText(val).then(() => Toast.show('Key copied!', 'success')).catch(() => Toast.show('Copy failed', 'warning'));
    });

    // Receive
    $('connect-btn').addEventListener('click', () => this._handleConnect());
    $('receive-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') this._handleConnect(); });

    // Toggle key field
    const keyGroup = $('key-group');
    const toggleKeyBtn = $('toggle-key-btn');
    const toggleKeyText = $('toggle-key-text');
    toggleKeyBtn?.addEventListener('click', () => {
      const show = keyGroup.hidden;
      keyGroup.hidden = !show;
      toggleKeyText.textContent = show ? 'Hide key' : 'Add key';
    });

    // Transfer controls
    $('pause-btn').addEventListener('click', () => this.transfer.pause());
    $('cancel-transfer-btn').addEventListener('click', () => {
      if (confirm('Cancel all transfers?')) {
        this.transfer.cancel();
        this.showError('Cancelled', 'You cancelled the transfer.');
      }
    });

    // Done / Error close
    $('done-close-btn').addEventListener('click', () => this.reset());
    $('error-close-btn').addEventListener('click', () => this.reset());

    // Settings
    const ss = $('setting-security'), sc = $('setting-chunk');
    if (ss) {
      ss.value = this.settings.security;
      ss.addEventListener('change', (e) => { this.settings.security = e.target.value; SettingsStore.save('security', e.target.value); });
    }
    if (sc) {
      sc.value = this.settings.chunkMode;
      sc.addEventListener('change', (e) => { this.settings.chunkMode = e.target.value; SettingsStore.save('chunkMode', e.target.value); });
    }

    const toggleAutoDl = () => {
      this.settings.autoDownload = !this.settings.autoDownload;
      SettingsStore.save('autoDownload', this.settings.autoDownload);
      const btn = $('setting-autodl');
      if (btn) btn.setAttribute('aria-checked', String(this.settings.autoDownload));
    };
    $('setting-autodl')?.addEventListener('click', toggleAutoDl);
    if (this.settings.autoDownload) {
      const btn = $('setting-autodl');
      if (btn) btn.setAttribute('aria-checked', 'true');
    }

    $('reset-settings-btn')?.addEventListener('click', () => {
      SettingsStore.reset();
      location.reload();
    });

    // Warn on unload during active transfer
    window.addEventListener('beforeunload', (e) => {
      if ($('transfer-overlay') && !$('transfer-overlay').hidden) {
        e.preventDefault(); e.returnValue = '';
      }
    });

    // Keyboard: Escape to close overlays
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('done-overlay')?.hidden) this.reset();
        if (!$('error-overlay')?.hidden) this.reset();
      }
    });
  },

  _handleConnect() {
    const raw = ($('receive-input')?.value || '').trim();
    if (!raw) { Toast.show('Paste a link or peer ID', 'warning'); return; }
    const keyVal = ($('receive-key')?.value || '').trim();
    this.peer.connectWithKey(raw, keyVal || null);
  },

    addFiles(fileList) {
    const incoming = Array.from(fileList);
    const merged = [...this.files.filter(f => f.file), ...incoming];
    if (merged.length > CONFIG.MAX_FILES) { Toast.show(`Max ${CONFIG.MAX_FILES} files allowed`, 'error'); return; }
    let total = 0;
    for (const f of merged) {
      if (f.size > CONFIG.MAX_FILE_SIZE) { Toast.show(`"${f.name}" exceeds the 2 GB limit`, 'error'); return; }
      total += f.size;
    }
    if (total > CONFIG.MAX_TOTAL_SIZE) { Toast.show('Total size exceeds 5 GB', 'error'); return; }
    this.files = merged.map(f => f.file ? f : { file: f, name: f.name, size: f.size, type: f.type || 'application/octet-stream' });
    this.renderFiles();
  },

  renderFiles() {
    const list = $('file-list');
    if (!list) return;
    list.innerHTML = '';
    const container = $('file-list-container');
    if (!this.files.length) { container.hidden = true; return; }
    container.hidden = false;
    const lbl = $('file-count-label');
    if (lbl) lbl.textContent = `${this.files.length} file${this.files.length !== 1 ? 's' : ''}`;
    const total = this.files.reduce((s, f) => s + f.size, 0);
    const tsl = $('total-size-label');
    if (tsl) tsl.textContent = fmtBytes(total);
    this.files.forEach((f, idx) => {
      const icon = phIcon(fileIconType(f.name));
      const removeBtn = el('button', 'file-remove', { 'aria-label': `Remove ${f.name}`, type: 'button' }, [
        el('i', 'ph ph-trash', { 'aria-hidden': 'true' })
      ]);
      removeBtn.addEventListener('click', () => { this.files.splice(idx, 1); this.renderFiles(); });
      const row = el('div', 'file-row', { role: 'listitem' }, [
        el('div', 'file-icon', {}, [el('i', `ph ${icon}`, { 'aria-hidden': 'true' })]),
        el('div', 'file-meta', {}, [
          el('p', 'file-name', { text: f.name }),
          el('p', 'file-size', { text: fmtBytes(f.size) }),
        ]),
        removeBtn,
      ]);
      list.appendChild(row);
    });
  },

  switchPanel(name) {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('is-active'));
    $(`panel-${name}`)?.classList.add('is-active');
    document.querySelectorAll('.nav-btn').forEach(b => {
      const active = b.dataset.panel === name;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-current', active ? 'page' : 'false');
    });
    // Close mobile sidebar on nav
    const sidebar = $('sidebar'), overlay = $('sidebar-overlay'), hamburger = $('hamburger');
    if (sidebar?.classList.contains('is-open')) {
      sidebar.classList.remove('is-open');
      overlay?.classList.remove('is-visible');
      hamburger?.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
    }
  },

  showTransfer() {
    $('transfer-overlay').hidden = false;
    this.transfer.renderQueue();
  },

  showDone(stats) {
    $('transfer-overlay').hidden = true;
    $('done-overlay').hidden = false;
    const duration = stats.start ? performance.now() - stats.start : 0;
    const speed = stats.total > 0 && duration > 0 ? (stats.total / (duration / 1000) / 1048576).toFixed(1) + ' MB/s' : '—';
    const ds = $('done-summary');
    if (ds) ds.textContent = `${this.transfer.queue.length} item${this.transfer.queue.length !== 1 ? 's' : ''} · ${fmtBytes(stats.total)} · ${fmtDuration(duration)}`;
    const sd = $('stat-duration'), ss = $('stat-speed'), sc = $('stat-chunks'), sr = $('stat-retries');
    if (sd) sd.textContent = fmtDuration(duration);
    if (ss) ss.textContent = speed;
    if (sc) sc.textContent = String(stats.chunks);
    if (sr) sr.textContent = String(stats.retries);

    const fc = $('done-files-container'), fl = $('done-file-list');
    if (!fc || !fl) return;
    fl.innerHTML = '';
    const downloadableItems = this.transfer.queue.filter(q => q.downloadUrl || q.textContent);
    if (!downloadableItems.length) { fc.hidden = true; return; }
    fc.hidden = false;

    downloadableItems.forEach(q => {
      let url, revoke = false;
      if (q.textContent) {
        url = URL.createObjectURL(new Blob([q.textContent], { type: 'text/plain' }));
        revoke = true;
      } else {
        url = q.downloadUrl;
      }
      const saveBtn = el('a', 'btn', { href: url, download: sanitizeFilename(q.name), text: 'Save' });
      if (revoke) saveBtn.addEventListener('click', () => setTimeout(() => URL.revokeObjectURL(url), 10000));
      const icon = phIcon(fileIconType(q.name));
      const row = el('div', 'done-file-row', { role: 'listitem' }, [
        el('div', 'queue-icon', {}, [el('i', `ph ${icon}`, { 'aria-hidden': 'true' })]),
        el('div', 'queue-info', {}, [
          el('p', 'queue-name', { text: q.name }),
          el('p', 'file-size', { text: fmtBytes(q.size) }),
        ]),
        saveBtn,
      ]);
      fl.appendChild(row);

      if (this.settings.autoDownload && !q.textContent) {
        setTimeout(() => {
          const a = document.createElement('a');
          a.href = url; a.download = sanitizeFilename(q.name);
          a.style.display = 'none'; document.body.appendChild(a); a.click();
          setTimeout(() => { a.remove(); }, 500);
        }, 400 * (downloadableItems.indexOf(q) + 1));
      }
    });

    // Wire the fixed "Download all" footer button
    const dlAllBtn = $('download-all-btn');
    if (dlAllBtn) {
      dlAllBtn.onclick = () => {
        downloadableItems.forEach((q, i) => {
          setTimeout(() => {
            const url = q.downloadUrl || URL.createObjectURL(new Blob([q.textContent], { type: 'text/plain' }));
            const a = document.createElement('a');
            a.href = url; a.download = sanitizeFilename(q.name);
            a.style.display = 'none'; document.body.appendChild(a); a.click();
            setTimeout(() => { a.remove(); if (!q.downloadUrl) URL.revokeObjectURL(url); }, 500);
          }, i * 250);
        });
      };
    }
  },

  showError(title, msg) {
    $('transfer-overlay').hidden = true;
    $('done-overlay').hidden = true;
    $('error-overlay').hidden = false;
    const et = $('error-title'), em = $('error-message');
    if (et) et.textContent = title;
    if (em) em.textContent = msg;
    const diag = $('error-diagnostics');
    if (!diag) return;
    diag.innerHTML = '';
    const items = [
      ['Time', new Date().toLocaleTimeString()],
      ['Mode', this.peer?.isReceiver ? 'Receiver' : 'Sender'],
      ['Security', this.settings?.security || '—'],
    ];
    for (const [k, v] of items) {
      diag.appendChild(el('div', '', {}, [
        el('span', '', { text: k + ':' }),
        el('span', '', { text: v }),
      ]));
    }
  },

  updateStatus(text, color) {
    const ts = $('topo-status');
    if (ts) ts.textContent = text;
    const you = $('topo-you'), peer = $('topo-peer'), line = $('topo-active-line'), packet = $('topo-packet');
    const fillMap = { success:'#34d399', danger:'#f87171', warning:'#fbbf24', info:'#60a5fa' };
    const lineX = { success:'120', danger:'20', warning:'60', info:'60' };
    const c = fillMap[color] || '#71717a';
    if (you) you.style.fill = c;
    if (peer) peer.style.fill = c;
    if (line) line.setAttribute('x2', lineX[color] || '20');
    if (packet) packet.classList.toggle('is-active', color === 'success');
  },

  reset() { window.location.href = window.location.pathname; },
};

document.addEventListener('DOMContentLoaded', () => App.init());
