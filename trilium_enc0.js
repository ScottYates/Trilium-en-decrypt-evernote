/*
 * trilium-enc0.js  —  Trilium note script
 *
 * Evernote-compatible ENC0 password protection for any Trilium note.
 * Encrypted sections are stored as <en-crypt cipher="AES" hint="..."
 * length="128">BASE64</en-crypt> — the exact same element shape that
 * Evernote uses inside ENEX exports, so anything encrypted here can
 * be exported to ENEX and imported into Evernote, and vice versa.
 *
 * The crypto is AES-128-CBC with PBKDF2-HMAC-SHA256 (50 000 iterations,
 * 16-byte keys) for both the AES and the integrity HMAC, exactly as
 * Evernote's <en-crypt> format. The password is never stored; an
 * optional per-session cache (keyed by hint) keeps the user from
 * typing the same password 50 times while reading a note.
 *
 * --------------------------------------------------------------------
 * Install (one-time, ~30 seconds)
 * --------------------------------------------------------------------
 *   1. In Trilium, create a new note, set type to "JS Code", language
 *      "JavaScript" (label type "code").
 *   2. Paste this entire file as the note body.
 *   3. Add the label `~run=frontendStartup` (the leading `~` is the
 *      `#` icon in Trilium's label picker — you want the
 *      `#run=frontendStartup` label).
 *   4. Save. Reload the app once. The script registers itself on
 *      the next frontend startup and stays installed.
 *
 * --------------------------------------------------------------------
 * Hotkeys
 * --------------------------------------------------------------------
 *   Three global hotkeys are installed on the first frontendStartup:
 *
 *     CTRL+SHIFT+E   →  Encrypt current selection
 *     CTRL+SHIFT+D   →  Decrypt all <en-crypt> blocks in the active note
 *     CTRL+SHIFT+F   →  Forget the in-memory password cache
 *
 *   The chord → action mapping lives in the HOTKEYS constant at the
 *   top of the IIFE (search for "const HOTKEYS"). Edit it there to
 *   remap or add hotkeys. The hotkeys are implemented as a capture-
 *   phase keydown listener on document, so they win over any other
 *   handler in the page.
 *
 *   The "wrap raw ENC0 blobs" action (🏷️) is toolbar-only — no
 *   hotkey — because it's a less-frequent operation and the others
 *   are the ones you reach for in everyday use.
 *
 * --------------------------------------------------------------------
 * Usage
 * --------------------------------------------------------------------
 *   After install, four buttons appear in the Trilium toolbar (and
 *   the three hotkeys above work from anywhere):
 *     🔒 Encrypt selection   🔓 Decrypt ENC0 blocks
 *     🏷️ Wrap raw ENC0 blobs  🔒 Forget ENC0 cache
 *
 *   - Open a note. Select text in the body. Click "🔒 Encrypt selection"
 *     (or press CTRL+SHIFT+E). A password prompt (and an optional
 *     visible hint) is shown; the selection is replaced with a
 *     single <en-crypt> element. Multi-paragraph selections correctly
 *     preserve their newlines.
 *
 *   - Open a note that contains <en-crypt> blocks. Click "🔓 Decrypt
 *     ENC0 blocks" (or press CTRL+SHIFT+D). Type the password; every
 *     <en-crypt> in the active note is replaced with its plaintext.
 *
 *   - (No in-place clickable placeholder — modern Trilium uses
 *     CKEditor 5 which clobbers direct DOM mutations. Use the
 *     toolbar / hotkey button above to decrypt whole notes at once.)
 *
 *   - The cache is wiped when you reload Trilium, or manually via
 *     the "🔒 Forget ENC0 cache" toolbar button (or CTRL+SHIFT+F).
 *
 * --------------------------------------------------------------------
 * Format reference (per Evernote)
 * --------------------------------------------------------------------
 *   4   bytes  "ENC0"            magic
 *   16  bytes  salt             (used to derive the AES key)
 *   16  bytes  salthmac         (used to derive the HMAC key)
 *   16  bytes  iv
 *   N   bytes  AES-128-CBC ciphertext (PKCS7-padded plaintext)
 *   32  bytes  bodyhmac         HMAC-SHA256(hmac_key, body)
 *
 *   body   = ENC0 || salt || salthmac || iv || ciphertext
 *   aes    = PBKDF2(pass, salt,    50000, sha256) -> 16 bytes
 *   hmac   = PBKDF2(pass, salthmac,50000, sha256) -> 16 bytes
 */

(() => {
  'use strict';

  // ============================================================
  //  0. User-tunable constants
  //     Edit these to change behavior. The rest of the file should
  //     be left alone unless you know what you're doing.
  // ============================================================

  // ---- Hotkeys ----
  //   Map a keyboard chord (case-insensitive, modifiers in any order,
  //   key name uppercased) to an action name. The action names must
  //   be functions exposed on the global __trilium_enc0__ object
  //   (actionEncryptSelection, actionDecryptAllInNote, etc.).
  //
  //   Recognized modifier tokens: CTRL, META, ALT, SHIFT.
  //   Key tokens: a single letter/digit, or a named key like
  //   ENTER, ESC, F1..F12, ARROWUP, etc.
  //
  //   Example: 'CTRL+ALT+E': 'actionEncryptSelection'
  //   To remove a hotkey, set its value to null.
  //   To add a new hotkey, add an entry to the map and a matching
  //   action on enc0Global further down.
  const HOTKEYS = {
    'CTRL+SHIFT+E': 'actionEncryptSelection',
    'CTRL+SHIFT+D': 'actionDecryptAllInNote',
    'CTRL+SHIFT+F': 'actionForgetCachedPasswords'
  };

  // ============================================================
  //  1. Pure crypto — no Trilium deps, so this part is unit-testable
  // ============================================================

  const ITER = 50000;
  const KEY_BYTES = 16;            // AES-128
  const SALT_BYTES = 16;
  const IV_BYTES = 16;
  // HMAC field in the blob is always 32 bytes (HMAC-SHA256 output).
  // The HMAC KEY is derived as 16 bytes from PBKDF2 (per Evernote spec).
  const HMAC_FIELD_BYTES = 32;     // size of the stored bodyhmac
  const HMAC_KEY_BYTES = 16;        // PBKDF2 output for the HMAC key
  const ENC0_MAGIC = [0x45, 0x4E, 0x43, 0x30]; // "ENC0"

  const utf8Encode = (s) => new TextEncoder().encode(s);
  const utf8Decode = (b) => new TextDecoder('utf-8').decode(b);

  function bytesToBase64(bytes) {
    let bin = '';
    // chunk to avoid call-stack limits on very large arrays
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    const clean = b64.replace(/[\s\n\r]/g, '');
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function constantTimeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  async function deriveAesBits(password, salt) {
    const baseKey = await crypto.subtle.importKey(
      'raw', utf8Encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
    );
    return crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
      baseKey, KEY_BYTES * 8
    );
  }

  async function importHmacKey(password, salt) {
    const baseKey = await crypto.subtle.importKey(
      'raw', utf8Encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
      baseKey, HMAC_KEY_BYTES * 8
    );
    return crypto.subtle.importKey(
      'raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
  }

  async function encryptEnc0(plaintext, password) {
    if (typeof plaintext === 'string') plaintext = utf8Encode(plaintext);
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const salthmac = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

    const aesBits = await deriveAesBits(password, salt);
    const hmacKey = await importHmacKey(password, salthmac);

    // Web Crypto's AES-CBC encrypt handles PKCS7 padding itself, so
    // we just pass the raw plaintext. (Earlier we pre-padded here,
    // but that caused double-padding in Node where subtle.encrypt
    // also pads, and the doubled-padded output only had the OUTER
    // padding stripped on decrypt.)
    const aesKey = await crypto.subtle.importKey(
      'raw', aesBits, { name: 'AES-CBC' }, false, ['encrypt']
    );
    const ctBuf = await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv }, aesKey, plaintext
    );
    const ct = new Uint8Array(ctBuf);

    // body = ENC0 || salt || salthmac || iv || ct
    const body = new Uint8Array(4 + SALT_BYTES * 2 + IV_BYTES + ct.length);
    body.set(ENC0_MAGIC, 0);
    body.set(salt, 4);
    body.set(salthmac, 4 + SALT_BYTES);
    body.set(iv, 4 + 2 * SALT_BYTES);
    body.set(ct, 4 + 2 * SALT_BYTES + IV_BYTES);

    const bodyhmac = new Uint8Array(
      await crypto.subtle.sign('HMAC', hmacKey, body)
    );

    const out = new Uint8Array(body.length + bodyhmac.length);
    out.set(body, 0);
    out.set(bodyhmac, body.length);
    return out;
  }

  async function decryptEnc0(blob, password) {
    if (blob.length < 4 + 2 * SALT_BYTES + IV_BYTES + HMAC_FIELD_BYTES) {
      throw new Error('ENC0 blob too short (' + blob.length + ' bytes)');
    }
    for (let i = 0; i < 4; i++) {
      if (blob[i] !== ENC0_MAGIC[i]) {
        throw new Error('Not an ENC0 blob (bad magic)');
      }
    }
    const salt = blob.slice(4, 4 + SALT_BYTES);
    const salthmac = blob.slice(4 + SALT_BYTES, 4 + 2 * SALT_BYTES);
    const iv = blob.slice(4 + 2 * SALT_BYTES, 4 + 2 * SALT_BYTES + IV_BYTES);
    const ct = blob.slice(4 + 2 * SALT_BYTES + IV_BYTES, blob.length - HMAC_FIELD_BYTES);
    const body = blob.slice(0, blob.length - HMAC_FIELD_BYTES);
    const bodyhmac = blob.slice(blob.length - HMAC_FIELD_BYTES);

    const hmacKey = await importHmacKey(password, salthmac);
    const expected = new Uint8Array(
      await crypto.subtle.sign('HMAC', hmacKey, body)
    );
    if (!constantTimeEqual(expected, bodyhmac)) {
      throw new Error('HMAC mismatch (wrong password or corrupt data)');
    }

    const aesBits = await deriveAesBits(password, salt);
    const aesKey = await crypto.subtle.importKey(
      'raw', aesBits, { name: 'AES-CBC' }, false, ['decrypt']
    );
    // Web Crypto's AES-CBC decrypt auto-strips PKCS7 padding and
    // throws on bad padding, so we don't need to check it ourselves.
    // (Evernote-produced blobs in the wild have been seen with a
    // '>' as the last byte of the unpadded plaintext — perfectly
    // valid, just not a PKCS7 pad value, which is what tipped this off.)
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aesKey, ct)
    );
  }

  // ============================================================
  //  2. <en-crypt> tag handling
  // ============================================================

  const EN_CRYPT_RE = /<en-crypt\b([^>]*)>([\s\S]*?)<\/en-crypt>/g;

  function parseAttrs(s) {
    const attrs = {};
    const re = /([\w-]+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(s)) !== null) attrs[m[1]] = m[2];
    return attrs;
  }

  function findEnCrypts(text) {
    const blocks = [];
    EN_CRYPT_RE.lastIndex = 0;
    let m;
    while ((m = EN_CRYPT_RE.exec(text)) !== null) {
      const b64 = m[2].replace(/[\s\n\r]/g, '');
      let blob = null;
      try { blob = base64ToBytes(b64); } catch (e) { /* leave null */ }
      blocks.push({
        start: m.index,
        end: m.index + m[0].length,
        attrs: parseAttrs(m[1]),
        b64,
        blob,
        full: m[0]
      });
    }
    return blocks;
  }

  function buildEnCryptTag(blob, hint) {
    const safeHint = (hint || '').replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<en-crypt cipher="AES" hint="${safeHint}" length="128">${bytesToBase64(blob)}</en-crypt>`;
  }

  // ============================================================
  //  3. Session password cache (keyed by hint)
  // ============================================================

  const cache = new Map(); // hint -> password

  function getCachedPassword(hint) {
    return cache.get(hint || '');
  }
  function setCachedPassword(hint, password) {
    if (password) cache.set(hint || '', password);
    else cache.delete(hint || '');
  }
  function clearAllCachedPasswords() {
    cache.clear();
  }

  // ============================================================
  //  4. Prompt shims.
  //  We try the native Trilium prompt first (api.dialog.prompt on
  //  older builds, api.prompt on the middle ones), and fall back to
  //  a self-built DOM modal. window.prompt is intentionally NOT used
  //  — Electron-based Trilium disables it (it throws "prompt() is
  //  not supported" at call time, which used to crash the actions).
  // ============================================================

  function buildPromptModal(opts) {
    // opts: { title, message, defaultValue, password, placeholder, confirmLabel, cancelLabel }
    return new Promise((resolve) => {
      if (typeof document === 'undefined' || !document.body) {
        resolve(null);
        return;
      }
      // Detect Trilium's theme so the modal doesn't look out of place.
      const isDark = (() => {
        try {
          if (document.documentElement.classList.contains('dark')) return true;
          if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return true;
        } catch (e) {}
        return false;
      })();
      const fg = isDark ? '#e0e0e0' : '#222';
      const bg = isDark ? '#2a2a2a' : '#fff';
      const border = isDark ? '#444' : '#ccc';
      const accent = isDark ? '#4a9eff' : '#0066cc';

      const overlay = document.createElement('div');
      overlay.className = 'trilium-enc0-modal';
      overlay.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'bottom:0',
        'background:rgba(0,0,0,0.5)',
        'display:flex', 'align-items:center', 'justify-content:center',
        'z-index:2147483647'  // sit above everything
      ].join(';');

      const box = document.createElement('div');
      box.style.cssText = [
        'background:' + bg, 'color:' + fg,
        'padding:20px 24px', 'border-radius:8px',
        'box-shadow:0 8px 32px rgba(0,0,0,0.4)',
        'min-width:320px', 'max-width:90vw',
        'font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'border:1px solid ' + border
      ].join(';');

      if (opts.title) {
        const t = document.createElement('div');
        t.textContent = opts.title;
        t.style.cssText = 'font-weight:600;font-size:15px;margin-bottom:8px';
        box.appendChild(t);
      }
      if (opts.message) {
        const m = document.createElement('div');
        m.textContent = opts.message;
        m.style.cssText = 'margin-bottom:14px;opacity:0.85';
        box.appendChild(m);
      }

      const input = document.createElement('input');
      input.type = opts.password ? 'password' : 'text';
      input.value = opts.defaultValue || '';
      input.placeholder = opts.placeholder || '';
      input.style.cssText = [
        'width:100%', 'box-sizing:border-box',
        'padding:8px 10px', 'font-size:14px',
        'background:' + (isDark ? '#1a1a1a' : '#fff'),
        'color:' + fg,
        'border:1px solid ' + border, 'border-radius:4px',
        'margin-bottom:14px', 'outline:none'
      ].join(';');
      input.addEventListener('focus', () => { input.style.borderColor = accent; });
      input.addEventListener('blur',  () => { input.style.borderColor = border; });
      box.appendChild(input);

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = opts.cancelLabel || 'Cancel';
      cancelBtn.style.cssText = [
        'padding:6px 16px', 'cursor:pointer', 'font-size:13px',
        'background:transparent', 'color:' + fg,
        'border:1px solid ' + border, 'border-radius:4px'
      ].join(';');
      const okBtn = document.createElement('button');
      okBtn.textContent = opts.confirmLabel || 'OK';
      okBtn.style.cssText = [
        'padding:6px 16px', 'cursor:pointer', 'font-size:13px',
        'background:' + accent, 'color:#fff',
        'border:1px solid ' + accent, 'border-radius:4px',
        'font-weight:500'
      ].join(';');

      row.appendChild(cancelBtn);
      row.appendChild(okBtn);
      box.appendChild(row);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      setTimeout(() => { try { input.focus(); input.select(); } catch (e) {} }, 0);

      function close(value) {
        try { document.body.removeChild(overlay); } catch (e) {}
        // Drop the keydown listener by garbage-collecting the closure.
        resolve(value);
      }
      okBtn.addEventListener('click',     () => close(input.value));
      cancelBtn.addEventListener('click', () => close(null));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')      { e.preventDefault(); close(input.value); }
        else if (e.key === 'Escape'){ e.preventDefault(); close(null); }
      });
      overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(null); }
      });
    });
  }

  async function promptPassword(message) {
    if (typeof api !== 'undefined' && api.dialog && api.dialog.prompt) {
      try { return await api.dialog.prompt({ title: 'ENC0', message, type: 'password' }); }
      catch (e) { /* fall through */ }
    }
    if (typeof api !== 'undefined' && api.prompt) {
      try { return await api.prompt({ message, defaultValue: '', showPassword: true }); }
      catch (e) { /* fall through */ }
    }
    return await buildPromptModal({ title: 'ENC0', message, password: true, confirmLabel: 'Encrypt' });
  }

  async function promptText(message, defaultValue) {
    if (typeof api !== 'undefined' && api.dialog && api.dialog.prompt) {
      try { return await api.dialog.prompt({ title: 'ENC0', message, defaultValue }); }
      catch (e) { /* fall through */ }
    }
    if (typeof api !== 'undefined' && api.prompt) {
      try { return await api.prompt({ message, defaultValue }); }
      catch (e) { /* fall through */ }
    }
    return await buildPromptModal({ title: 'ENC0', message, defaultValue });
  }

  function notify(message) {
    if (typeof api !== 'undefined' && api.showMessage) api.showMessage(message);
    else if (typeof console !== 'undefined') console.log('[enc0]', message);
  }

  function notifyError(message) {
    if (typeof api !== 'undefined' && api.showError) api.showError(message);
    else if (typeof console !== 'undefined') console.error('[enc0]', message);
  }

  // ============================================================
  //  5. Note / editor access (Trilium-version-agnostic, async-aware)
  //
  //  Modern Trilium (post-v0.60) returns Promises from these getters
  //  and wraps note.getContent() in an object: { content, mime }.
  //  All of these helpers await the underlying API and normalize
  //  the various shapes into a plain string.
  // ============================================================

  async function getActiveNote() {
    if (typeof api === 'undefined') return null;
    if (typeof api.getActiveContextNote === 'function') {
      try { return await api.getActiveContextNote(); } catch (e) { return null; }
    }
    if (api.activeNote) return api.activeNote;
    return null;
  }

  // note.getContent() may return: a string, {content, mime}, or a Promise
  // resolving to either of those. Normalize to string.
  function _extractContent(c) {
    if (typeof c === 'string') return c;
    if (c == null) return '';
    if (typeof c === 'object') {
      if (typeof c.content === 'string') return c.content;
      if (typeof c.text === 'string') return c.text;
      if (typeof c.toString === 'function') {
        try { const s = c.toString(); if (s && s !== '[object Object]') return s; } catch (e) {}
      }
    }
    return String(c);
  }

  async function getNoteText(note) {
    if (!note) return '';
    try {
      if (typeof note.getContent === 'function') {
        return _extractContent(await note.getContent());
      }
      if (typeof note.content !== 'undefined') return _extractContent(note.content);
    } catch (e) { return ''; }
    return '';
  }

  async function setNoteText(note, text) {
    if (!note) return;
    try {
      if (typeof note.setContent === 'function') {
        // Modern Trilium takes (content, mime) — preserve whatever mime
        // the note already has if we can read it.
        let mime;
        try {
          if (typeof note.getContent === 'function') {
            const cur = await note.getContent();
            if (cur && typeof cur === 'object' && cur.mime) mime = cur.mime;
          }
        } catch (e) {}
        await note.setContent(text, mime);
        return;
      }
    } catch (e) {}
    try { note.content = text; } catch (e) {}
  }

  // Get the currently active CodeMirror text editor (or null).
  // Modern Trilium: api.getActiveContextTextEditor() returns a Promise.
  async function getActiveTextEditor() {
    if (typeof api === 'undefined') return null;
    if (typeof api.getActiveContextTextEditor === 'function') {
      try { return await api.getActiveContextTextEditor(); } catch (e) { /* fall through */ }
    }
    const note = await getActiveNote();
    if (note && note.textEditor) return note.textEditor;
    return null;
  }

  // Try a list of strategies for "get the current selection in the active
  // note editor" in order of modernity, returning the first that works.
  // Modern Trilium uses a Lexical-based editor which exposes getSelectedHtml()
  // but not getSelection() / getValue(). We convert the HTML to plain text.
  async function getEditorSelection() {
    const ed = await getActiveTextEditor();
    if (ed) {
      // ---- CodeMirror 5/6: getSelection() ----
      if (typeof ed.getSelection === 'function') {
        try { return ed.getSelection(); } catch (e) {}
      }
      if (ed.cm && typeof ed.cm.getSelection === 'function') {
        try { return ed.cm.getSelection(); } catch (e) {}
      }
      // ---- CM6 view.state.selection + view.state.doc ----
      try {
        if (ed.state && ed.state.selection && ed.state.doc) {
          const r = ed.state.selection.main;
          return ed.state.doc.sliceString(r.from, r.to);
        }
      } catch (e) {}
      // ---- Trilium's Lexical wrapper: getSelectedHtml() ----
      if (typeof ed.getSelectedHtml === 'function') {
        try {
          const html = ed.getSelectedHtml();
          if (html) {
            // Convert HTML to text but PRESERVE block boundaries as
            // newlines. tmp.textContent alone would collapse
            // "<p>line1</p><p>line2</p>" into "line1line2" because
            // textContent doesn't insert newlines at <p> boundaries.
            // We pre-substitute block-closing tags and <br> with \n
            // before stripping the rest of the tags. We use ONLY the
            // closing forms so adjacent paragraphs don't get a
            // double newline (one from the </p>, one from the next
            // <p>).
            const withBreaks = String(html)
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote)\s*>/gi, '\n');
            // Strip remaining tags and decode HTML entities.
            const text = withBreaks
              .replace(/<[^>]+>/g, '')
              .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
              .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
              .replace(/[ \t]+\n/g, '\n')               // strip trailing whitespace on each line
              .replace(/^\n+|\n+$/g, '');              // strip leading/trailing newlines
            if (text) return text;
          }
        } catch (e) {}
      }
      // ---- Lexical: read the editor state directly (private API) ----
      try {
        if (typeof ed.getEditorState === 'function') {
          const state = ed.getEditorState();
          // Lexical's state has _selection (private). The selection has
          // getTextContent() that returns the selected text.
          const sel = state._selection;
          if (sel && typeof sel.getTextContent === 'function') {
            const text = sel.getTextContent();
            if (text) return text;
          }
        }
      } catch (e) {}
      // ---- Some Trilium editor wrappers expose .getValue + a selection object ----
      if (typeof ed.listSelections === 'function') {
        try {
          const sels = ed.listSelections();
          if (sels && sels.length) {
            const v = (typeof ed.getValue === 'function') ? ed.getValue() : '';
            return sels.map(s => v.substring(s.from, s.to)).join('\n');
          }
        } catch (e) {}
      }
      // ---- Lexical: try DOM selection on the editor's root element ----
      try {
        if (typeof ed.getRootElement === 'function') {
          const root = ed.getRootElement();
          if (root && typeof window !== 'undefined' && window.getSelection) {
            const sel = window.getSelection();
            if (sel && sel.rangeCount && !sel.getRangeAt(0).collapsed) return sel.toString();
          }
        }
      } catch (e) {}
    }
    // Fallback to DOM selection (works in plain contenteditable / textarea)
    if (typeof window !== 'undefined' && window.getSelection) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && !sel.getRangeAt(0).collapsed) return sel.toString();
    }
    return '';
  }

  // Try to replace the editor's current selection. Returns true on success.
  // Async because modern Trilium's editor/note getters return Promises.
  // The function tries a cascade of strategies, in order:
  //   0. Trilium high-level API (preferred on modern Trilium)
  //   1. Note-level splice (writes to DB; works for any editor)
  //   2. Direct editor methods (CodeMirror 5/6, Lexical)
  //   3. DOM selection fallback (plain contenteditable)
  async function replaceEditorSelection(replacement) {
    const log = (m) => { if (typeof console !== 'undefined') console.log('[enc0:replace]', m); };

    // ---- 0. Trilium API: removeSelection() + addTextToActiveContextEditor() ----
    //     addTextToActiveContextEditor inserts at the cursor (which sits
    //     at the END of the selection) but does NOT delete the
    //     selected text. So we first call editor.removeSelection() to
    //     delete the selected text, then insert the replacement at the
    //     (now collapsed) cursor.
    if (typeof api !== 'undefined' && typeof api.addTextToActiveContextEditor === 'function') {
      try {
        const ed = await getActiveTextEditor();
        if (ed && typeof ed.removeSelection === 'function') {
          try { ed.removeSelection(); } catch (e) { /* may throw if no selection */ }
        }
        api.addTextToActiveContextEditor(replacement);
        log('addTextToActiveContextEditor + removeSelection OK');
        return true;
      } catch (e) {
        log('addTextToActiveContextEditor threw: ' + e.message);
      }
    }

    // ---- 1. Note-level splice: writes to DB, works regardless of editor ----
    const note = await getActiveNote();
    if (note) {
      const noteText = await getNoteText(note);
      const sel = await getEditorSelection();
      if (sel && typeof noteText === 'string' && noteText.indexOf(sel) !== -1) {
        const idx = noteText.indexOf(sel);
        const newVal = noteText.substring(0, idx) + replacement + noteText.substring(idx + sel.length);
        try {
          await setNoteText(note, newVal);
          log('note-level splice OK (offset ' + idx + ')');
          return true;
        } catch (e) { log('note-level splice threw: ' + e.message); }
      }
    }

    // ---- 2. Direct editor methods: CodeMirror 5/6, Lexical ----
    const ed = await getActiveTextEditor();
    if (ed) {
      // CodeMirror 5/6: direct replaceSelection
      if (typeof ed.replaceSelection === 'function') {
        try { ed.replaceSelection(replacement); log('ed.replaceSelection OK'); return true; }
        catch (e) { log('ed.replaceSelection threw: ' + e.message); }
      }
      if (ed.cm && typeof ed.cm.replaceSelection === 'function') {
        try { ed.cm.replaceSelection(replacement); return true; } catch (e) {}
      }
      // CM6: view.dispatch with a replacement transaction
      try {
        if (ed.state && ed.dispatch) {
          const sel2 = ed.state.selection.main;
          ed.dispatch({ changes: { from: sel2.from, to: sel2.to, insert: replacement } });
          return true;
        }
      } catch (e) {}
    }

    // ---- 3. DOM selection fallback (plain contenteditable) ----
    if (typeof document !== 'undefined') {
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        if (!range.collapsed) {
          range.deleteContents();
          const node = document.createTextNode(replacement);
          range.insertNode(node);
          range.setStartAfter(node);
          range.setEndAfter(node);
          sel.removeAllRanges();
          sel.addRange(range);
          log('DOM-selection fallback OK');
          return true;
        }
      }
    }
    log('all strategies failed');
    return false;
  }

  // Walk the CKEditor 5 model tree, find every text node whose
  // content contains an escaped <en-crypt>...</en-crypt> tag, and
  // replace just the matched range with the matching plaintext
  // from the b64Map (keyed by the en-crypt tag's base64). The
  // b64Map values are either a string (the plaintext) or null
  // (this block failed to decrypt — leave it alone). Preserves
  // the surrounding paragraph structure, formatting attributes
  // (bold/italic/etc.), and whitespace. onReplaced is called
  // once per successful replacement.
  //
  // Why b64-keyed and not index-keyed? With an index, the walker
  // assumes the model iteration order matches the blocks list
  // order. That holds in the common case (separate paragraphs)
  // but if the user's editor ever produces a structure we didn't
  // anticipate (inline blocks, a single text node containing
  // multiple en-crypt tags, model reordering, etc.) the index
  // alignment silently breaks and a wrong-position plaintext
  // gets inserted. b64 matching is structural: each en-crypt
  // tag in the model is matched against the block that produced
  // it, so the right plaintext always lands in the right block
  // no matter how the model is laid out.
  function _walkModelForEncrypted(editor, writer, b64Map, onReplaced) {
    const root = editor.model.document.getRoot();
    if (!root) return;
    // CKEditor 5's MODEL stores text in the UNESCAPED form
    // (e.g. "<en-crypt ...>BASE64</en-crypt>"). The HTML view
    // escapes it to "&lt;en-crypt...&gt;BASE64&lt;/en-crypt&gt;",
    // but by the time we read the model directly, the &lt;/&gt;
    // entities are gone. The previous walker regex was for the
    // escaped form, which is why it never matched anything in the
    // model — the setData fallback was doing all the work, and it
    // was using the HINT (not b64) to find tags, which is what
    // caused the "wrong block" bug. We now match BOTH forms to be
    // safe.
    const ENC_RE = /<en-crypt\b([^>]*)>([^<]*)<\/en-crypt>|&lt;en-crypt\b([^&]*)&gt;([^&]*)&lt;\/en-crypt&gt;/g;
    const log = (m) => { if (typeof console !== 'undefined') console.log('[enc0:walker] ' + m); };
    function walk(node) {
      if (!node || typeof node.getChildren !== 'function') return;
      const children = Array.from(node.getChildren());
      for (const child of children) {
        if (child.is && child.is('$text')) {
          const data = child.data;
          if (!data) continue;
          ENC_RE.lastIndex = 0;
          const m = ENC_RE.exec(data);
          if (m) {
            // The base64 is in m[2] (unescaped) or m[4] (escaped).
            const rawB64 = (m[2] != null) ? m[2] : m[4];
            if (rawB64 == null) return;
            // Strip whitespace from the captured base64 (the model
            // may insert newlines; findEnCrypts strips them on the
            // blocks side, so we need to match that here too).
            const mB64 = rawB64.replace(/[\s\n\r]/g, '');
            const plaintext = b64Map[mB64];
            const preview = (s) => typeof s === 'string' ? (s.length > 24 ? s.slice(0, 24) + '…' : s) : String(s);
            const keyPreview = mB64.length > 16 ? mB64.slice(0, 16) + '…' : mB64;
            if (plaintext == null) {
              log('b64=' + keyPreview + ' no match (null), leaving tag in place');
              return;
            }
            log('b64=' + keyPreview + ' matched plaintext=' + preview(plaintext));
            const parent = child.parent;
            if (!parent) return;
            // Split the plaintext on \n so multi-line selections
            // decrypt into multiple paragraphs (or a single
            // paragraph with <br> breaks, depending on the case).
            // This matches the setData path's linebreak handling
            // so both paths produce the same output.
            const lines = String(plaintext).split('\n');
            const startOff = child.startOffset + m.index;
            const endOff   = child.startOffset + m.index + m[0].length;
            try {
              const start = writer.createPositionAt(parent, startOff);
              const range = writer.createRange(start, writer.createPositionAt(parent, endOff));
              writer.remove(range);
              if (lines.length === 1) {
                // Simple case: single line, just insert as text.
                writer.insertText(plaintext, start);
              } else {
                // Multi-line: figure out if the en-crypt tag is the
                // only content of its parent paragraph ("own <p>"
                // case) or shares it with other text ("inline" case).
                // For own <p>, we replace the whole paragraph with
                // one paragraph per line. For inline, we keep the
                // surrounding paragraph and insert <br> between
                // lines.
                //
                // Own-<p> detection: the paragraph has exactly one
                // child, and that child is THIS text node. CKEditor
                // 5 elements don't have getData() — only text nodes
                // do — so the previous para.getData() check always
                // returned '' and the own-<p> case never fired.
                // That was the bug that dropped the second line.
                const para = (parent && parent.is && parent.is('element')) ? parent : (parent && parent.parent) || parent;
                const paraChildren = (para && typeof para.getChildren === 'function') ? Array.from(para.getChildren()) : [];
                const isOwnPara = paraChildren.length === 1 && paraChildren[0] === child;
                log('multi-line: ' + lines.length + ' lines, isOwnPara=' + isOwnPara + ', paraChildren=' + paraChildren.length);
                if (isOwnPara) {
                  // Replace the entire paragraph with one
                  // paragraph per line. The first line goes into
                  // the current paragraph (which we just emptied);
                  // subsequent lines go into new paragraphs.
                  const paraName = (para && para.name) || 'paragraph';
                  writer.insertText(lines[0], start);
                  let lastPara = para;
                  for (let i = 1; i < lines.length; i++) {
                    const newPara = writer.createElement(paraName);
                    writer.insertText(lines[i], newPara);
                    writer.insert(newPara, writer.createPositionAfter(lastPara));
                    lastPara = newPara;
                  }
                } else {
                  // Inline case: keep the surrounding paragraph,
                  // insert lines joined by <br> soft-break
                  // elements. CRITICAL: after inserting a
                  // softBreak we MUST also insert the text that
                  // follows it — the previous version dropped
                  // the second line because it inserted the
                  // softBreak but not the text after it.
                  writer.insertText(lines[0], start);
                  let lastPos = writer.createPositionAt(parent, startOff + lines[0].length);
                  for (let i = 1; i < lines.length; i++) {
                    let inserted = false;
                    try {
                      const br = writer.createElement('softBreak');
                      writer.insert(br, lastPos);
                      // Insert the text AFTER the softBreak so we
                      // get "<br>line2" not just "<br>".
                      const afterBr = writer.createPositionAfter(br);
                      writer.insertText(lines[i], afterBr);
                      // The new text is now the last text node
                      // in the paragraph; advance lastPos to its
                      // end so the next iteration inserts after
                      // it.
                      lastPos = writer.createPositionAt(parent, 'end');
                      inserted = true;
                    } catch (e2) { /* softBreak not allowed */ }
                    if (!inserted) {
                      // Fallback: append the next line as text
                      // after a literal \n.
                      try {
                        writer.insertText('\n' + lines[i], lastPos);
                        lastPos = writer.createPositionAt(parent, 'end');
                      } catch (e3) { /* bail */ }
                    }
                  }
                }
              }
              onReplaced();
            } catch (e) { log('writer op threw: ' + e.message); }
            // After mutation, the rest of this text node is gone.
            // Don't recurse further into it. Walk the parent's
            // remaining children (after this child) instead.
            const parentChildren = Array.from(node.getChildren());
            const idx = parentChildren.indexOf(child);
            for (let i = idx + 1; i < parentChildren.length; i++) {
              if (parentChildren[i].is && parentChildren[i].is('element')) walk(parentChildren[i]);
            }
            return;
          }
        } else if (child.is && child.is('element')) {
          walk(child);
        }
      }
    }
    walk(root);
  }

  // ============================================================
  //  6. Actions.
  //  IMPORTANT: these action bodies must NOT reference any of the
  //  IIFE-scoped helpers by their bare name (e.g. `getSelectionText`,
  //  `promptPassword`, `notify`). Trilium's `addButtonToToolbar` evals
  //  the action source through `new Function(...)` / `executeBundle`,
  //  which drops lexical scope. Every helper they need must be looked
  //  up via the globalThis.__trilium_enc0__ object, which is defined
  //  further down and is reachable from any global eval'd code.
  // ============================================================

  async function actionEncryptSelection() {
    const g = globalThis.__trilium_enc0__;
    const sel = await g.getEditorSelection();
    if (!sel) { g.notifyError('Select text in the note to encrypt first.'); return; }
    const note = await g.getActiveNote();
    if (!note) { g.notifyError('No active note.'); return; }
    const password = await g.promptPassword('Set a password for this encrypted section:');
    if (!password) return;
    const hint = (await g.promptText('Optional visible hint (leave blank for none):', '')) || '';
    const blob = await g.encrypt(sel, password);
    const tag = g.buildEnCryptTag(blob, hint);
    const replaced = await g.replaceEditorSelection(tag);
    if (!replaced) {
      try { if (navigator.clipboard) await navigator.clipboard.writeText(tag); } catch (e) {}
      g.notify('I could not replace the selection directly. The <en-crypt> tag has been copied to your clipboard — paste it where you want it.');
      return;
    }
    g.cache.set(hint, password);
    g.notify('Encrypted ' + sel.length + ' characters.');
    // Place the cursor at the END of the SAME LINE the user was
    // on. We use index-based navigation (paragraph index in the
    // root's children) rather than element reference, because the
    // setData path can re-initialize the model and a reference
    // would be stale. The index is just a number and survives that.
    const targetParagraphIdx = await g.getCursorParagraphIndex();
    await g.placeCursorAtParagraphIndex(targetParagraphIdx, 'end');
  }

  async function actionDecryptAllInNote() {
    const g = globalThis.__trilium_enc0__;
    const note = await g.getActiveNote();
    if (!note) { g.notifyError('No active note.'); return; }
    // Save the index of the paragraph the cursor is currently in
    // BEFORE the decrypt. After the decrypt, we'll place the cursor
    // at the end of that same paragraph (so the user stays on the
    // same line they were on when they clicked Decrypt). We use the
    // index, not the element reference, because the setData path can
    // re-initialize the model and the reference would be stale.
    const targetParagraphIdx = await g.getCursorParagraphIndex();
    const originalText = await g.getNoteText(note);
    // Diagnostic: what does the note text actually look like?
    if (typeof console !== 'undefined') {
      console.log('[enc0:decrypt] note text length=' + originalText.length +
                  ', contains &lt;en-crypt: ' + (originalText.indexOf('&lt;en-crypt') !== -1));
    }
    // If the note text is HTML-escaped (CKEditor tends to do this when
    // raw text containing < and > is inserted), decode the entities
    // FIRST and work entirely in the decoded form. Otherwise our
    // decoded-block-text won't match the original escaped form when
    // we try to splice it back in.
    const decodedText = originalText
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
    const isEscaped = decodedText !== originalText;
    const workText = isEscaped ? decodedText : originalText;
    let blocks = g.findEnCrypts(workText);
    if (blocks.length === 0) {
      g.notify('No <en-crypt> blocks in this note.');
      return;
    }
    const password = await g.promptPassword('Decryption password:');
    if (!password) return;
    let newText = workText;
    let decrypted = 0;
    for (const b of blocks) {
      try {
        const pt = await g.decrypt(b.blob, password);
        newText = newText.replace(b.full, g.utf8Decode(pt));
        g.cache.set(b.attrs.hint || '', password);
        decrypted += 1;
      } catch (e) { /* wrong password — leave block alone */ }
    }
    if (decrypted > 0) {
      // Build the {hint -> plaintext} map so we can swap the
      // encrypted blocks in both the note DB and the editor view.
      const hintToPlaintext = {};
      for (const b of blocks) {
        const hint = b.attrs.hint || '';
        if (hintToPlaintext[hint] != null) continue;
        try {
          const pt = await g.decrypt(b.blob, password);
          hintToPlaintext[hint] = g.utf8Decode(pt);
        } catch (e) { /* skip */ }
      }
      // Persist the new content to the DB.
      const outText = isEscaped
        ? newText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        : newText;
      await g.setNoteText(note, outText);
      // Now update the EDITOR view. Trilium's editor is CKEditor 5
      // (the active text editor is a wrapper around a CKEditor
      // instance with .ck-content / .ck-editor__editable). The
      // encrypted block lives in the editor as escaped text inside a
      // <p> tag, not as a placeholder span.
      const ed = await g.getActiveTextEditor();
      let refreshed = false, edStrategy = '(no editor)';
      if (ed) {
        // escLine is accessed via the global in the eval'd action
        // body, so it needs to be on enc0Global. We define it here
        // (in the closure) and stash it on the global for the action
        // to reach.
        g._escLine = g._escLine || function (s) {
          // Convert newlines to <br> so a multi-line plaintext stays
          // multi-line when setData'd back into CKEditor (which
          // would otherwise collapse \n into a single space inside a <p>).
          return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
        };
        const escLine = g._escLine;

        // ---- CKEditor 5: model API (preferred — preserves formatting) ----
        //     We walk the model tree, find text nodes containing the
        //     escaped <en-crypt> tag, and replace them with the
        //     matching plaintext via writer.remove() + writer.insertText().
        //     This preserves the surrounding paragraph structure,
        //     formatting attributes (bold/italic/lists/etc.), and
        //     whitespace — setData() would normalize all of those.
        if (!refreshed) {
          const editor = (ed._context && ed._context.editor) || ed;
          if (editor && editor.model && typeof editor.model.change === 'function') {
            try {
              let modelReplaced = 0;
              // Build a {b64 -> plaintext} map. We key by the
              // en-crypt tag's base64 content (NOT by document
              // index). The walker matches each en-crypt tag in
              // the model to its block by base64, so a password
              // that only matches the MIDDLE block can never put
              // that block's plaintext into the FIRST block's
              // position. null = block failed to decrypt (wrong
              // password); the walker leaves it alone.
              const b64Map = {};
              for (const b of blocks) {
                try {
                  b64Map[b.b64] = g.utf8Decode(await g.decrypt(b.blob, password));
                } catch (e) { b64Map[b.b64] = null; }
              }
              if (typeof console !== 'undefined') {
                const k = Object.keys(b64Map);
                const preview = (s) => typeof s === 'string' ? (s.length > 24 ? s.slice(0, 24) + '…' : s) : String(s);
                console.log('[enc0:decrypt] model API: ' + blocks.length + ' blocks, b64Map keys: ' +
                  k.map(x => x.slice(0,8) + '…→' + preview(b64Map[x])).join(', '));
                // Log model shape
                try {
                  const root = editor.model.document.getRoot();
                  const rootKids = root.getChildren();
                  console.log('[enc0:decrypt] model root has ' + rootKids.length + ' children: ' +
                    Array.from(rootKids).map(c => (c.is && c.is('$text')) ? 'TEXT' : (c.name || 'element')).join(', '));
                } catch (e) {}
              }
              // Run the walker. Cursor placement happens at the
              // end of the action via placeCursorAtParagraphIndex,
              // so we don't try to restore the cursor inside the
              // model.change block here.
              editor.model.change(writer => {
                _walkModelForEncrypted(editor, writer, b64Map, () => { modelReplaced++; });
              });
              if (typeof console !== 'undefined') console.log('[enc0:decrypt] model API replaced ' + modelReplaced + ' block(s)');
              if (modelReplaced > 0) {
                edStrategy = 'CKEditor model API';
                refreshed = true;
              }
            } catch (e) {
              if (typeof console !== 'undefined') console.log('[enc0:decrypt] model API threw: ' + e.message);
            }
          }
        }
        // ---- CKEditor 5: getData / setData (fallback) ----
        //     setData re-initializes the editor, which can normalize
        //     whitespace and lose formatting — but it always works,
        //     so we keep it as the last resort. We use sequential,
        //     in-order replacement so multiple blocks with the same
        //     hint get matched 1:1 (rather than all collapsing to the
        //     first block's plaintext as the old g-flag regex did).
        if (!refreshed && typeof ed.getData === 'function' && typeof ed.setData === 'function') {
          try {
            const data = await ed.getData();
            // Build the per-block plaintext list (in document order).
            const perBlockPlaintexts = [];
            for (const b of blocks) {
              try {
                perBlockPlaintexts.push(g.utf8Decode(await g.decrypt(b.blob, password)));
              } catch (e) { perBlockPlaintexts.push(null); }
            }
            // For each block, find its (next) escaped tag in the data
            // and replace it with the corresponding plaintext as a
            // series of <p> elements (so newlines survive re-parse).
            //
            // CRITICAL: we match by the block's BASE64, not its HINT.
            // Two blocks can legitimately share a hint (e.g. both have
            // empty hints), and if we used the hint, the regex would
            // always find the FIRST occurrence and overwrite it with
            // whichever block's plaintext we're processing — which is
            // exactly the "block 2's content ends up in block 1's
            // position" bug we just fixed in the walker. b64 is
            // unique per encryption (random salt + IV), so it
            // guarantees we find the right tag.
            let newData = data;
            let cursor = 0;
            let blockIdx = 0;
            let replaced = 0;
            for (const b of blocks) {
              if (blockIdx >= perBlockPlaintexts.length) break;
              const pt = perBlockPlaintexts[blockIdx++];
              if (pt == null) continue;
              // Escape any regex special characters in the b64.
              // (base64 alphabet is A-Z a-z 0-9 + / = — so only + /
              // and = are special, but escape the whole standard set
              // to be safe.)
              const escB64 = b.b64.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const re = new RegExp(
                '&lt;en-crypt\\b[^&]*&gt;' + escB64 + '&lt;/en-crypt&gt;'
              );
              re.lastIndex = cursor;
              const m = re.exec(newData);
              if (!m) {
                if (typeof console !== 'undefined') console.log('[enc0:setData] could not find b64=' + escB64.slice(0,16) + '… in editor data');
                continue;
              }
              const lines = String(pt).split('\n');
              // Build the replacement. For the "block is in its own
              // <p>" case (the common case — user encrypted a self-
              // contained block of text), we replace the entire <p>
              // with new <p> blocks. For the inline case (the <p>
              // also contains other text), we just insert the
              // plaintext inline with explicit <br>s for newlines.
              // Inline display:block on each new <p> prevents Trilium
              // theme CSS from rendering them on one line.
              const blockStyle = ' style="display:block;margin:0;padding:0;"';
              const prefix = newData.substring(0, m.index);
              const suffix = newData.substring(m.index + m[0].length);
              const pOpen = prefix.lastIndexOf('<p');
              const pCloseStart = suffix.indexOf('</p>');
              const isOwnP = pOpen !== -1 && pCloseStart !== -1 && (() => {
                const pContent = (prefix.substring(pOpen) + m[0] + suffix.substring(0, pCloseStart))
                  .replace(/<[^>]+>/g, '').trim();
                const mContent = m[0].replace(/<[^>]+>/g, '').trim();
                return pContent === mContent;
              })();
              let replacement;
              if (lines.length > 1 && isOwnP) {
                replacement = lines.map(line => '<p' + blockStyle + '>' + escLine(line) + '</p>').join('');
                newData = prefix.substring(0, pOpen) + replacement + suffix.substring(pCloseStart + 4);
                cursor = (prefix.substring(0, pOpen) + replacement).length;
              } else if (lines.length > 1) {
                replacement = lines.map(escLine).join('<br>');
                newData = prefix + replacement + suffix;
                cursor = m.index + replacement.length;
              } else {
                replacement = escLine(pt);
                newData = prefix + replacement + suffix;
                cursor = m.index + replacement.length;
              }
              replaced++;
            }
            if (replaced > 0 && newData !== data) {
              await ed.setData(newData);
              edStrategy = 'CKEditor getData/setData';
              refreshed = true;
            } else {
              edStrategy = 'CKEditor getData: no change';
            }
          } catch (e) {
            if (typeof console !== 'undefined') console.log('[enc0:decrypt] setData threw: ' + e.message);
          }
        }
        // ---- Fallback: DOM-side <p> replacement (last resort) ----
        if (!refreshed) {
          try {
            const root = (typeof ed.getRootElement === 'function') ? ed.getRootElement() : null;
            const searchRoot = root || (typeof document !== 'undefined' && document.querySelector('.ck-editor__editable, .ck-content, [contenteditable="true"]'));
            if (searchRoot) {
              const ps = searchRoot.querySelectorAll('p');
              let blockIdx = 0;
              const perBlockPlaintexts = [];
              for (const b of blocks) {
                try {
                  perBlockPlaintexts.push(g.utf8Decode(await g.decrypt(b.blob, password)));
                } catch (e) { perBlockPlaintexts.push(null); }
              }
              for (const p of Array.from(ps)) {
                const text = p.textContent || '';
                if (text.indexOf('<en-crypt') === -1) continue;
                const pt = perBlockPlaintexts[blockIdx++];
                if (pt == null) continue;
                const lines = String(pt).split('\n');
                p.innerHTML = lines.length > 1
                  ? lines.map(line => escLine(line)).join('<br>') // last-resort DOM doesn't get <p> split
                  : escLine(pt);
                refreshed = true;
              }
              edStrategy = 'DOM <p> replacement';
            }
          } catch (e) {
            if (typeof console !== 'undefined') console.log('[enc0:decrypt] DOM <p> replacement threw: ' + e.message);
          }
        }
      }
      if (typeof console !== 'undefined') {
        console.log('[enc0:decrypt] editor strategy: ' + edStrategy + ', refreshed=' + refreshed);
      }
      g.notify('Decrypted ' + decrypted + ' block(s).');
      // Put the cursor at the end of the same paragraph the user
      // was on before clicking Decrypt. They want the cursor to
      // stay on the same line — not at the start, not at the end
      // of the document, just at the end of their original
      // paragraph. We use index-based navigation so this works
      // even if the setData path re-initialized the model.
      await g.placeCursorAtParagraphIndex(targetParagraphIdx, 'end');
    } else {
      g.notifyError('No blocks decrypted — wrong password?');
    }
  }

  function actionForgetCachedPasswords() {
    const g = globalThis.__trilium_enc0__;
    g.cache.clear();
    g.notify('Cached ENC0 passwords cleared.');
  }

  // Find raw ENC0 base64 blobs in the active note and wrap each one
  // in a <en-crypt> tag so the decrypt action can find it. This is
  // for notes that were imported from Evernote/ENEX where the
  // <en-crypt> wrapper was stripped or the plaintext was pasted
  // directly. We identify a blob by:
  //   - starts with the base64 of "ENC0" (i.e. "RU5DMA==")
  //   - has at least 84 raw bytes of content (4 magic + 16 salt +
  //     16 salthmac + 16 iv + 32 hmac = 84), which is 112 base64
  //     chars including the "RU5DMA==" prefix
  //   - is a continuous run of base64 chars (no whitespace, no
  //     '<', no '>') — so it won't match across HTML tags
  //   - is not already inside an existing <en-crypt>...</en-crypt>
  // The HMAC is NOT verified (we don't have a password yet); we
  // just tag the text so a later decrypt-with-password can pick it
  // up. A bad tag will just fail to decrypt.
  async function actionWrapEnCryptBlobs() {
    const g = globalThis.__trilium_enc0__;
    const note = await g.getActiveNote();
    if (!note) { g.notifyError('No active note.'); return; }
    const originalText = await g.getNoteText(note);
    if (!originalText) { g.notify('Note is empty.'); return; }

    // Collect existing <en-crypt> regions so we don't double-wrap.
    // We use a list of [start, end] pairs and check each raw-blob
    // match against them.
    const existingRegions = [];
    const tagRe = /<en-crypt\b[^>]*>[\s\S]*?<\/en-crypt>/g;
    let m;
    while ((m = tagRe.exec(originalText))) {
      existingRegions.push([m.index, m.index + m[0].length]);
    }

    // Find raw ENC0 blobs. The b64 of the first 4 bytes ("ENC0" =
    // 0x45 0x4E 0x43 0x30) is "RU5DM" followed by a char in 'A'..'P'
    // (the high nibble of the 5th byte is 0 because byte 4 is 0x30).
    // The 6th b64 char encodes 00xxxx where xxxx is the high nibble
    // of byte 5, so it falls in 'A' (00 0000) to 'P' (00 1111).
    // (The full "RU5DMA==" prefix only appears for a 4-byte blob;
    // longer blobs shift the boundary and produce a different 6th
    // char.) We require 104+ more b64 chars (so the raw bytes are
    // at least 84 — the 4 magic + 16 salt + 16 salthmac + 16 iv +
    // 32 hmac minimum). The regex doesn't match across whitespace,
    // '<', or '>', so it won't grab HTML tags.
    const blobRe = /RU5DM[A-P][A-Za-z0-9+/=]{106,}/g;
    const candidates = [];
    while ((m = blobRe.exec(originalText))) {
      const start = m.index;
      const end = start + m[0].length;
      // Skip if this blob is inside an existing <en-crypt> tag.
      let insideExisting = false;
      for (const [rs, re] of existingRegions) {
        if (start >= rs && end <= re) { insideExisting = true; break; }
      }
      if (!insideExisting) {
        candidates.push({ start, end, text: m[0] });
      }
    }

    if (candidates.length === 0) {
      g.notify('No raw ENC0 blobs found in this note.');
      return;
    }

    // Wrap each match. Build the new text right-to-left so the
    // earlier indices don't shift as we insert text.
    let newText = originalText;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const { start, end, text: blob } = candidates[i];
      newText = newText.slice(0, start)
        + '<en-crypt cipher="AES" hint="" length="128">' + blob + '</en-crypt>'
        + newText.slice(end);
    }

    await g.setNoteText(note, newText);

    // Refresh the editor view so the user sees the wrapped version.
    // We use the same cascade as the decrypt action: CKEditor 5
    // model API first (preserves formatting), then setData
    // fallback, then DOM replacement.
    const ed = await g.getActiveTextEditor();
    if (ed) {
      const editor = (ed._context && ed._context.editor) || ed;
      // The simplest reliable update is setData — the model is
      // small and the user just ran an explicit "wrap" action.
      if (typeof ed.getData === 'function' && typeof ed.setData === 'function') {
        try { ed.setData(newText); } catch (e) { /* best effort */ }
      } else {
        const root = editor.model && editor.model.document && editor.model.document.getRoot();
        if (root && editor.model.change) {
          editor.model.change(writer => {
            try {
              while (root.getChild(0)) writer.remove(root.getChild(0));
            } catch (e) {}
            try {
              const fragment = writer.createHtmlElementFromString(newText);
              writer.insert(fragment, root, 'end');
            } catch (e) {}
          });
        }
      }
    }

    g.notify('Tagged ' + candidates.length + ' raw ENC0 blob' + (candidates.length === 1 ? '' : 's') + '.');
  }

  // ============================================================
  //  7. CSS (placeholder styling kept for future use)
  // ============================================================

  function installCss() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('trilium-enc0-style')) return;
    const s = document.createElement('style');
    s.id = 'trilium-enc0-style';
    s.textContent = `
      .trilium-enc0-block {
        display: inline-block;
        background: rgba(255, 196, 0, 0.18);
        border: 1px dashed #c8a000;
        border-radius: 4px;
        padding: 1px 8px;
        cursor: pointer;
        user-select: none;
        font-style: italic;
        line-height: 1.6;
      }
      .trilium-enc0-block:hover {
        background: rgba(255, 196, 0, 0.32);
      }
      .trilium-enc0-block .trilium-enc0-lock {
        margin-right: 4px;
      }
      .trilium-enc0-revealed {
        background: rgba(0, 200, 100, 0.12);
        border-radius: 3px;
        padding: 2px 6px;
        white-space: pre-wrap;
      }
      .trilium-enc0-relock {
        margin-left: 6px;
        font-size: 0.85em;
        cursor: pointer;
        background: transparent;
        border: 1px solid #888;
        border-radius: 3px;
        padding: 1px 6px;
        color: inherit;
      }
    `;
    document.head.appendChild(s);
  }

  // ============================================================
  //  NOTE: An earlier version of this module had a "render hook"
  //  here that walked the DOM and replaced <en-crypt> text nodes
  //  with yellow placeholder spans. It worked in plain-text /
  //  non-CKEditor Trilium, but in modern Trilium (CKEditor 5) the
  //  editor maintains its own model and reverts any direct DOM
  //  mutation on every model-to-view sync, so the placeholder was
  //  applied and immediately clobbered. The right fix would be a
  //  CKEditor plugin (custom inline element + schema + conversion,
  //  ~150 lines). For now, the toolbar / hotkey buttons handle
  //  encrypt and decrypt; the CSS for a future placeholder is kept
  //  in installCss() below.
  // ============================================================

  // ============================================================
  //  8. Context-menu / command registration
  // ============================================================

  function installCommands() {
    if (typeof api === 'undefined' || api == null) return;

    // Modern Trilium (post-v0.63): no addNoteContextMenuItem, no addCommand.
    // We use addButtonToToolbar instead. Each button operates on whatever
    // note is the active context.
    const items = [
      { title: '🔒 Encrypt selection',     icon: 'lock',        action: actionEncryptSelection },
      { title: '🔓 Decrypt ENC0 blocks',   icon: 'lock-open',   action: actionDecryptAllInNote },
      { title: '🏷️ Wrap raw ENC0 blobs',  icon: 'tag',         action: actionWrapEnCryptBlobs },
      { title: '🔒 Forget ENC0 cache',     icon: 'eraser',      action: actionForgetCachedPasswords }
    ];

    let registered = 0;
    if (typeof api.addButtonToToolbar === 'function') {
      for (const item of items) {
        try {
          // Some Trilium versions take an object, some take (title, icon, action).
          // Try the object form first, then positional, then positional-without-icon.
          let ok = false;
          try { api.addButtonToToolbar(item); ok = true; } catch (e) {}
          if (!ok) { try { api.addButtonToToolbar(item.title, item.icon, item.action); ok = true; } catch (e) {} }
          if (!ok) { try { api.addButtonToToolbar(item.title, item.action); ok = true; } catch (e) {} }
          if (ok) {
            registered++;
            console.log('[trilium-enc0] added toolbar button:', item.title);
          } else {
            console.warn('[trilium-enc0] could not add toolbar button:', item.title);
          }
        } catch (e) {
          console.warn('[trilium-enc0] addButtonToToolbar failed for', item.title, e);
        }
      }
    } else {
      console.warn('[trilium-enc0] api.addButtonToToolbar is not a function; cannot install UI hooks');
    }

    // Legacy fallbacks for older Trilium builds that still ship them.
    if (typeof api.addNoteContextMenuItem === 'function') {
      const legacy = [
        { title: '🔒 Encrypt selection (ENC0)',          handler: actionEncryptSelection,      uiIcon: 'lock' },
        { title: '🔓 Decrypt <en-crypt> blocks in note',  handler: actionDecryptAllInNote,      uiIcon: 'lock-open' },
        { title: '🔒 Forget cached ENC0 passwords',       handler: actionForgetCachedPasswords, uiIcon: 'eraser' }
      ];
      for (const item of legacy) {
        try { api.addNoteContextMenuItem(item); registered++; }
        catch (e) {
          try { api.addNoteContextMenuItem(item.title, item.handler, item.uiIcon); registered++; }
          catch (e2) { /* ignore */ }
        }
      }
    }
    if (typeof api.addCommand === 'function') {
      try { api.addCommand({ name: 'trilium-enc0/encrypt-selection', noteName: 'ENC0: Encrypt selection', icon: 'lock',      action: actionEncryptSelection }); registered++; } catch (e) {}
      try { api.addCommand({ name: 'trilium-enc0/decrypt-note',      noteName: 'ENC0: Decrypt blocks',     icon: 'lock-open', action: actionDecryptAllInNote }); registered++; } catch (e) {}
      try { api.addCommand({ name: 'trilium-enc0/forget-cache',      noteName: 'ENC0: Forget cache',       icon: 'eraser',    action: actionForgetCachedPasswords }); registered++; } catch (e) {}
    }

    if (typeof console !== 'undefined') {
      console.log(`[trilium-enc0] registered ${registered} UI hooks total`);
    }
  }

  // ============================================================
  //  9. Expose internals so users can call them from other notes
  // ============================================================

  // Make the module callable from other Trilium scripts:
  //   const enc0 = globalThis.__trilium_enc0__;
  //   const pt = await enc0.decryptString(b64Blob, 'pw');
  // (Use globalThis rather than window so the same code works whether
  // `window` is the global (browsers) or a module-scoped var (Node).)
  // Build the public surface. Everything reachable from a button click
  // (which gets eval'd by Trilium and therefore runs without any
  // lexical scope) is exposed here so the actions can look helpers up
  // through `globalThis.__trilium_enc0__.<helper>()` at call-time.
  const enc0Global = {
    // crypto
    encrypt: encryptEnc0,           // (plaintext, password) -> Uint8Array
    decrypt: decryptEnc0,           // (blob, password) -> Uint8Array
    encryptString: async (s, pw) => bytesToBase64(await encryptEnc0(s, pw)),
    decryptString: async (b64, pw) => utf8Decode(await decryptEnc0(base64ToBytes(b64), pw)),
    buildEnCryptTag,                // (blob, hint) -> '<en-crypt ...>...</en-crypt>'
    findEnCrypts,                   // (text) -> [{start,end,attrs,b64,blob,full}]

    // encoding helpers
    utf8Encode,
    utf8Decode,
    bytesToBase64,
    base64ToBytes,

    // prompt / notify shims
    promptPassword,
    promptText,
    notify,
    notifyError,

    // Trilium-version-agnostic note / editor access
    getActiveNote,
    getActiveTextEditor,
    getNoteText,
    setNoteText,
    getEditorSelection,
    replaceEditorSelection,

    // Get the index (in the root's children) of the paragraph that
    // currently contains the cursor or selection. Returns -1 if the
    // cursor isn't in any paragraph. This index is stable across
    // model re-initializations (the setData path re-creates the
    // model, but the paragraph ordering usually stays the same), so
    // we can use it AFTER an operation to navigate back to the
    // user's original line.
    getCursorParagraphIndex: async () => {
      try {
        const ed = await getActiveTextEditor();
        if (!ed) return -1;
        const editor = (ed && ed._context && ed._context.editor) || ed;
        if (!editor || !editor.model) return -1;
        const sel = editor.model.document.selection;
        if (!sel) return -1;
        const anchor = sel.anchor || (sel.getFirstRange && sel.getFirstRange().start);
        if (!anchor) return -1;
        let p = anchor.parent;
        // Walk up to the nearest paragraph element.
        while (p && (!p.is || !p.is('element') || p.name === '$root')) p = p.parent;
        if (!p || !p.parent) return -1;
        if (typeof p.parent.getChildren !== 'function') return -1;
        const siblings = Array.from(p.parent.getChildren());
        return siblings.indexOf(p);
      } catch (e) { return -1; }
    },

    // Place the cursor at the start ('start') or end ('end', default)
    // of the paragraph at the given index. Uses index-based navigation
    // (NOT element reference) so it survives model re-initialization
    // via setData. Follows the same pattern as Trilium's own
    // EditableText scrollToEnd: model.change → setSelection →
    // view.focus → requestAnimationFrame(scrollToTheSelection).
    // The rAF defer matters — the view renderer needs a tick to
    // update the DOM selection to match the model, so an immediate
    // scrollToTheSelection can fire before the DOM caret has moved.
    placeCursorAtParagraphIndex: async (index, where) => {
      where = where || 'end';
      const log = (m) => { try { if (typeof console !== 'undefined') console.log('[enc0:cursor] ' + m); } catch (e) {} };
      try {
        if (typeof index !== 'number' || index < 0) {
          log('bad index ' + index);
          return;
        }
        const ed = await getActiveTextEditor();
        if (!ed) return;
        const editor = (ed && ed._context && ed._context.editor) || ed;
        if (!editor || !editor.model || typeof editor.model.change !== 'function') return;
        const root = editor.model.document.getRoot();
        if (!root) return;
        // Dump document structure (paragraph count + first ~40 chars
        // of each) so it's obvious whether the target paragraph is
        // where we think — the "empty paragraphs at top" perception
        // bug was invisible without this.
        try {
          const all = Array.from(root.getChildren());
          const dump = all.map((c, i) => {
            let txt = '';
            try {
              if (c.is && c.is('$text')) txt = c.data;
              else if (c.is && c.is('element')) {
                const children = Array.from(c.getChildren ? c.getChildren() : []);
                txt = children.map(cc => (cc.is && cc.is('$text')) ? cc.data : '<' + (cc.name || '?') + '>').join('');
              }
            } catch (e) {}
            return `[${i}] (${c.name || '$text'}) "${String(txt).slice(0, 40)}"`;
          }).join(' | ');
          log('doc structure: ' + all.length + ' children: ' + dump);
        } catch (e) {}
        // Find the paragraph at the given index.
        let paragraph = null;
        try {
          paragraph = (typeof root.getChild === 'function')
            ? root.getChild(index)
            : (root.getChildren ? Array.from(root.getChildren())[index] : null);
        } catch (e) {}
        if (!paragraph || (paragraph.is && paragraph.is('$text'))) return;
        let placedOk = false;
        editor.model.change(writer => {
          try {
            const pos = (where === 'start')
              ? writer.createPositionAt(paragraph, 0)
              : writer.createPositionAt(paragraph, 'end');
            writer.setSelection(pos);
            placedOk = true;
          } catch (e) {
            log('setSelection threw: ' + e.message);
          }
        });
        try { editor.editing.view.focus(); } catch (e) {}
        // Defer scroll + diagnostic to the next animation frame so
        // the view renderer has a chance to sync the DOM selection.
        const scrollAndReport = () => {
          try {
            if (typeof editor.editing?.view?.scrollToTheSelection === 'function') {
              editor.editing.view.scrollToTheSelection();
            } else if (typeof editor.scrollToTheSelection === 'function') {
              editor.scrollToTheSelection();
            }
          } catch (e) {}
          // Post-placement diagnostic: model + view + DOM caret.
          // If the user reports the cursor is in the wrong place,
          // this single line tells us everything.
          try {
            const sel = editor.model.document.selection;
            const a = sel.anchor;
            let modelNow = '?';
            if (a) {
              const path = Array.from(a.path);
              let p = a.parent;
              while (p && (!p.is || !p.is('element') || p.name === '$root')) p = p.parent;
              const sibs = p && p.parent ? Array.from(p.parent.getChildren()) : [];
              const idx = p && p.parent ? sibs.indexOf(p) : -1;
              modelNow = 'path=' + JSON.stringify(path) + ' paragraph[' + idx + '] offset=' + a.offset;
            }
            let viewNow = '?';
            try {
              const vRange = editor.editing.view.document.selection.getFirstRange();
              if (vRange) {
                // View Range.start is a TreeWalkerPosition; its .path
                // is a Path object, not a plain Array — build the
                // path manually by walking the parent chain.
                const vPath = [];
                let n = vRange.start;
                while (n && n.parent) {
                  const par = n.parent;
                  const sibs = par.getChildren ? Array.from(par.getChildren()) : [];
                  vPath.unshift(sibs.indexOf(n));
                  n = par;
                }
                viewNow = 'view-path=' + JSON.stringify(vPath);
              }
            } catch (e) { viewNow = 'view-err: ' + e.message; }
            const isFocused = editor.editing.view.document.isFocused;
            const edDom = (typeof document !== 'undefined') ? document.querySelector('.ck-editor__editable, .ck-content, [contenteditable="true"]') : null;
            const domSel = (typeof document !== 'undefined' && document.getSelection) ? document.getSelection() : null;
            let domInfo = 'no-dom';
            if (domSel && domSel.rangeCount > 0) {
              const r = domSel.getRangeAt(0);
              const rect = r.getBoundingClientRect();
              const edRect = edDom ? edDom.getBoundingClientRect() : null;
              const text = (r.startContainer.nodeType === 3) ? r.startContainer.data : (r.startContainer.textContent || '');
              const paraEl = r.startContainer.parentElement;
              const paraRect = paraEl ? paraEl.getBoundingClientRect() : null;
              const allP = edDom ? Array.from(edDom.querySelectorAll('p')) : [];
              const paraIndex = paraEl ? allP.indexOf(paraEl) : -1;
              domInfo = 'DOM anchorNode=' + r.startContainer.nodeName +
                ' offset=' + r.startOffset +
                ' caret-top=' + Math.round(rect.top) +
                (edRect ? ' editor-top=' + Math.round(edRect.top) : '') +
                (paraRect ? ' para-top=' + Math.round(paraRect.top) + ' para[' + paraIndex + ']' : '') +
                ' text="' + text.slice(Math.max(0, r.startOffset - 5), r.startOffset + 10) + '"';
            } else if (edDom && edDom === document.activeElement) {
              domInfo = 'editor-focused-but-no-dom-range';
            } else {
              domInfo = 'no-dom-selection';
            }
            log('FINAL placedOk=' + placedOk + ' model=' + modelNow + ' ' + viewNow + ' focused=' + isFocused + ' ' + domInfo);
          } catch (e) { log('diagnostic threw: ' + e.message); }
        };
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => requestAnimationFrame(scrollAndReport));
        } else {
          setTimeout(scrollAndReport, 0);
        }
      } catch (e) {
        log('threw: ' + e.message);
      }
    },

    // the three actions (so other notes can call them too)
    actionEncryptSelection,
    actionDecryptAllInNote,
    actionWrapEnCryptBlobs,
    actionForgetCachedPasswords,

    // HTML-encoding helper used by the setData path. The eval'd
    // action body can't see closure-scoped functions, so this needs
    // to be on the global.
    _escLine: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'),

    // password cache
    cache: {
      get: getCachedPassword,
      set: setCachedPassword,
      clear: clearAllCachedPasswords
    }
  };
  globalThis.__trilium_enc0__ = enc0Global;

  // ============================================================
  //  10. Direct hotkeys.
  //  A keydown listener on document watches for the combinations in
  //  HOTKEYS (defined at the top of the IIFE) and dispatches the
  //  matching action. preventDefault + stopPropagation ensure
  //  Trilium doesn't navigate or do anything else in response. No
  //  #keyboardShortcut note needed, no flash, no jump.
  // ============================================================

  function _chordFromEvent(ev) {
    const parts = [];
    if (ev.ctrlKey)  parts.push('CTRL');
    if (ev.metaKey)  parts.push('META');
    if (ev.altKey)   parts.push('ALT');
    if (ev.shiftKey) parts.push('SHIFT');
    let k = ev.key || '';
    if (k.length === 1) k = k.toUpperCase();
    else if (k === ' ') k = 'SPACE';
    parts.push(k);
    return parts.join('+').toUpperCase();
  }

  function _installDirectHotkeys() {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    const log = (m) => { if (typeof console !== 'undefined') console.log('[enc0:hotkey]', m); };
    log('hotkeys: ' + Object.keys(HOTKEYS).join(', '));
    document.addEventListener('keydown', (ev) => {
      // Skip only when the user is doing PLAIN typing (no modifier)
      // in a text field. With a modifier held, this is a hotkey and
      // we should act regardless of where focus is.
      const t = ev.target;
      const tag = t && t.tagName;
      const hasModifier = ev.ctrlKey || ev.altKey || ev.metaKey;
      if (!hasModifier) {
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) {
          return;
        }
      }
      const actionName = HOTKEYS[_chordFromEvent(ev)];
      if (!actionName) return;
      ev.preventDefault();
      ev.stopPropagation();
      log('hotkey ' + _chordFromEvent(ev) + ' -> ' + actionName);
      const fn = enc0Global[actionName];
      if (typeof fn !== 'function') return;
      try {
        Promise.resolve(fn()).catch(e => {
          if (typeof console !== 'undefined') console.error('[enc0:hotkey] ' + actionName + ' threw: ' + e.message);
        });
      } catch (e) {
        if (typeof console !== 'undefined') console.error('[enc0:hotkey] ' + actionName + ' threw: ' + e.message);
      }
    }, true /* capture phase, so we beat any other handler */);
  }

  // ============================================================
  //  11. Bootstrap
  // ============================================================

  function bootstrap() {
    installCss();
    installCommands();
    _installDirectHotkeys();
    if (typeof console !== 'undefined') {
      console.log('[trilium-enc0] module installed');
    }
  }

  if (typeof document === 'undefined') {
    // No DOM (unlikely in Trilium). Nothing to do.
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
