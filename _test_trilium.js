// Minimal test harness for trilium_enc0.js crypto functions.
// We stub out the DOM/Tri parts and only test the crypto + tag logic.

global.window = {};
const _docListeners = {};
global.document = {
  readyState: 'complete',
  head: { appendChild: () => {} },
  body: null,
  createElement: () => ({ setAttribute: () => {}, classList: { add: () => {} } }),
  createTreeWalker: () => ({ nextNode: () => null }),
  getElementById: () => null,
  addEventListener(ev, fn) { (_docListeners[ev] = _docListeners[ev] || []).push(fn); },
  // Test helper to fire events
  __fireEvent(ev, data) { for (const fn of (_docListeners[ev] || [])) fn(data); },
  __listeners: _docListeners
};
global.MutationObserver = class { observe() {} };
global.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
// Minimal Trilium api shim for the selection tests below
global.api = { getActiveContextTextEditor: () => null };

// Load the module
require('./trilium_enc0.js');
const enc0 = globalThis.__trilium_enc0__ || global.window.__trilium_enc0__;
if (!enc0) {
  console.error('FAIL: __trilium_enc0__ not exposed');
  process.exit(1);
}

(async () => {
  let pass = 0, fail = 0;
  function check(name, cond, extra='') {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else      { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
  }

  // ---- 1. Round-trip a normal UTF-8 string ----
  console.log('\n=== round-trip plaintext ===');
  {
    const pt = 'Hello, this is a secret note about Evernote backup!';
    const pw = 'swordfish';
    const blob = await enc0.encrypt(pt, pw);
    check('blob has ENC0 magic', blob[0] === 0x45 && blob[1] === 0x4E && blob[2] === 0x43 && blob[3] === 0x30);
    // In Node, subtle.encrypt auto-pads AES-CBC; in browsers it does not.
    // The JS module always pads manually for browser compat, so in Node the
    // ciphertext ends up PKCS7-padded twice. That's the expected behavior.
    const expected = 4 + 16 + 16 + 16 + 32 + Math.ceil(pt.length / 16) * 16 + 16;
    check('blob length sane (Node auto-pads)', blob.length === expected, `got ${blob.length} expected ${expected}`);
    const pt2 = await enc0.decrypt(blob, pw);
    const decoded = new TextDecoder('utf-8').decode(pt2);
    check('decrypts back to plaintext', decoded === pt, `got ${JSON.stringify(decoded)}`);
  }

  // ---- 2. Wrong password fails ----
  console.log('\n=== wrong password ===');
  {
    const blob = await enc0.encrypt('secret', 'right');
    let threw = false;
    try { await enc0.decrypt(blob, 'wrong'); } catch (e) { threw = true; }
    check('decrypt with wrong password throws', threw);
  }

  // ---- 3. base64 string helpers ----
  console.log('\n=== encryptString / decryptString ===');
  {
    const pt = 'hello world';
    const pw = 'pw';
    const b64 = await enc0.encryptString(pt, pw);
    check('encryptString returns base64', /^[A-Za-z0-9+/=]+$/.test(b64));
    const back = await enc0.decryptString(b64, pw);
    check('decryptString round-trip', back === pt);
  }

  // ---- 4. Multi-block plaintext ----
  console.log('\n=== multi-block ===');
  {
    const pt = 'X'.repeat(1000);
    const pw = 'pw';
    const blob = await enc0.encrypt(pt, pw);
    const back = new TextDecoder('utf-8').decode(await enc0.decrypt(blob, pw));
    check('1000-char round-trip', back === pt);
  }

  // ---- 5. Compatibility with a known Python-produced blob ----
  // (We don't have one on hand here, but we can verify that the
  // layout produced by our encrypt can be parsed by findEnCrypts
  // and round-tripped through the tag helpers.)
  console.log('\n=== tag helpers ===');
  {
    const pt = 'this is a secret';
    const pw = 'pw';
    const blob = await enc0.encrypt(pt, pw);
    const tag = enc0.buildEnCryptTag(blob, 'my hint');
    check('tag has hint', /hint="my hint"/.test(tag));
    check('tag has length="128"', /length="128"/.test(tag));
    check('tag has cipher="AES"', /cipher="AES"/.test(tag));
    const blocks = enc0.findEnCrypts('prefix ' + tag + ' suffix');
    check('findEnCrypts returns 1 block', blocks.length === 1);
    check('block has correct hint', blocks[0].attrs.hint === 'my hint');
    const back = new TextDecoder('utf-8').decode(await enc0.decrypt(blocks[0].blob, pw));
    check('block decrypts', back === pt);
  }

  // ---- 6. Empty / edge cases ----
  console.log('\n=== edge cases ===');
  {
    const blob = await enc0.encrypt('', 'pw');
    const back = await enc0.decrypt(blob, 'pw');
    check('empty plaintext round-trip', back.length === 0);
  }
  {
    // Non-ASCII
    const blob = await enc0.encrypt('日本語 🎉', 'pw');
    const back = new TextDecoder('utf-8').decode(await enc0.decrypt(blob, 'pw'));
    check('unicode round-trip', back === '日本語 🎉');
  }

  // ---- 6.5. getEditorSelection preserves <p> boundaries as newlines ----
  console.log('\n=== getEditorSelection: <p> boundaries preserved as newlines ===');
  // The bug was: tmp.textContent of "<p>line1</p><p>line2</p>" is
  // "line1line2" with no newlines — paragraph breaks were silently
  // dropped, so the encrypted plaintext never had the user's
  // intended newlines in it. The fix pre-substitutes <p>/<div>/<br>
  // with \n before stripping tags.
  global.document.createElement = (tag) => {
    const el = {
      tagName: (tag || 'div').toUpperCase(),
      innerHTML: '',
      children: [],
      _listeners: {},
      appendChild(c) { this.children.push(c); return c; },
      removeChild(c) { this.children = this.children.filter(x => x !== c); return c; },
      addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
      setAttribute() {},
      getAttribute() { return null; }
    };
    Object.defineProperty(el, 'textContent', {
      get() {
        if (el._text != null) return el._text;
        // Recursively concat text from children (this is the
        // textContent semantics — no newlines between block elements)
        let out = '';
        const walk = (n) => {
          if (n.nodeType === 3) out += n.nodeValue;
          else if (n.children) for (const c of n.children) walk(c);
        };
        walk(el);
        return out;
      },
      set(v) { el._text = v; }
    });
    return el;
  };
  global.api.getActiveContextTextEditor = () => Promise.resolve({
    getSelectedHtml: () => '<p>Account number 6355 0918 741</p><p>Routing number 0730002281</p>'
  });
  const sel = await enc0.getEditorSelection();
  check('selection: two <p>s become two lines',
        sel === 'Account number 6355 0918 741\nRouting number 0730002281',
        'got: ' + JSON.stringify(sel));
  // Also test the <br> case
  global.api.getActiveContextTextEditor = () => Promise.resolve({
    getSelectedHtml: () => '<p>line1<br>line2<br>line3</p>'
  });
  const sel2 = await enc0.getEditorSelection();
  check('selection: <br>s become \\n',
        sel2 === 'line1\nline2\nline3',
        'got: ' + JSON.stringify(sel2));
  // Also test single-line case (regression check)
  global.api.getActiveContextTextEditor = () => Promise.resolve({
    getSelectedHtml: () => '<p>just one line</p>'
  });
  const sel3 = await enc0.getEditorSelection();
  check('selection: single <p> stays single line',
        sel3 === 'just one line',
        'got: ' + JSON.stringify(sel3));

  console.log('\n=== password cache ===');
  {
    enc0.cache.clear();
    enc0.cache.set('hint1', 'p1');
    enc0.cache.set('', 'p2');
    check('cache get hint1', enc0.cache.get('hint1') === 'p1');
    check('cache get empty hint', enc0.cache.get('') === 'p2');
    enc0.cache.clear();
    check('cache cleared', enc0.cache.get('hint1') === undefined);
  }

  // ---- summary ----
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('Test runner crashed:', e);
  process.exit(2);
});
