// Simulate Trilium's addButtonToToolbar boundary: it evals the
// action's source through new Function(), which drops lexical scope.
// We extract each action's .toString() and rebuild it via the Function
// constructor, then call it. If the refactor is correct, the rebuilt
// action still works (because every helper lookup goes through
// globalThis.__trilium_enc0__ at call-time).

global.window = {};
global.document = {
  readyState: 'complete',
  head: { appendChild: () => {} },
  body: null,
  createElement: () => ({ setAttribute: () => {}, classList: { add: () => {} } }),
  createTreeWalker: () => ({ nextNode: () => null }),
  getElementById: () => null,
  addEventListener(ev, fn) { (this._listeners = this._listeners || {})[ev] = (this._listeners[ev] || []).concat([fn]); },
  __fireEvent(ev, data) { for (const fn of ((this._listeners && this._listeners[ev]) || [])) fn(data); }
};
global.MutationObserver = class { observe() {} };
global.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };

// Tiny localStorage mock for the cross-context listener test
const _lsStore = {};
global.localStorage = {
  getItem: (k) => Object.prototype.hasOwnProperty.call(_lsStore, k) ? _lsStore[k] : null,
  setItem: (k, v) => { _lsStore[k] = String(v); },
  removeItem: (k) => { delete _lsStore[k]; },
  clear: () => { for (const k in _lsStore) delete _lsStore[k]; }
};

// Minimal Trilium `api` shim
global.api = {
  getActiveContextNote: () => null,    // simulate "no active note" path
  getActiveContextTextEditor: () => null,
  showMessage: (m) => console.log('  [notify]', m),
  showError: (m) => console.log('  [error]', m)
};

require('./trilium_enc0.js');
const enc0 = globalThis.__trilium_enc0__;
if (!enc0) { console.error('FAIL: not exposed'); process.exit(1); }

(async () => {
  let pass = 0, fail = 0;
  function check(name, cond, extra='') {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else      { fail++; console.log('  FAIL  ' + name + '  ' + extra); }
  }

  // --- 1. The action is reachable on the global ---
  console.log('\n=== actions on global ===');
  check('actionEncryptSelection is a function', typeof enc0.actionEncryptSelection === 'function');
  check('actionDecryptAllInNote is a function', typeof enc0.actionDecryptAllInNote === 'function');
  check('actionForgetCachedPasswords is a function', typeof enc0.actionForgetCachedPasswords === 'function');

  // --- 2. Forget-cache can be called directly (via global lookup) ---
  console.log('\n=== actionForgetCachedPasswords direct call ===');
  enc0.cache.set('hint', 'p');
  check('cache has entry', enc0.cache.get('hint') === 'p');
  enc0.actionForgetCachedPasswords();
  check('cache cleared after action', enc0.cache.get('hint') === undefined);

  // --- 3. Re-eval the action through `new Function()`, simulating
  //        Trilium's addButtonToToolbar boundary. The rebuilt function
  //        must still work because the body looks up helpers via
  //        globalThis.__trilium_enc0__, not via closure. ---
  console.log('\n=== actionForgetCachedPasswords survives eval boundary ===');
  enc0.cache.set('h1', 'p1');
  enc0.cache.set('h2', 'p2');
  check('cache has 2 entries before', enc0.cache.get('h1') === 'p1' && enc0.cache.get('h2') === 'p2');
  const rebuilt = new Function('return globalThis.__trilium_enc0__.actionForgetCachedPasswords()')();
  check('rebuilt-forget did not throw', true);
  check('cache cleared after rebuilt-forget', enc0.cache.get('h1') === undefined && enc0.cache.get('h2') === undefined);

  // --- 4. Encrypt action body, when extracted & eval'd, can still
  //        reference every helper it needs (via globalThis) ---
  console.log('\n=== actionEncryptSelection body parsed & eval\'d ===');
  const src = enc0.actionEncryptSelection.toString();
  // Rebuild as a fresh async function. If the body used closure
  // references (e.g. bare `getSelectionText()`), this would throw
  // ReferenceError when invoked.
  let rebuiltEncrypt;
  try {
    rebuiltEncrypt = new Function('return ' + src)();
    check('actionEncryptSelection parsed via new Function()', typeof rebuiltEncrypt === 'function');
  } catch (e) {
    check('actionEncryptSelection parsed via new Function()', false, e.message);
  }
  // The rebuilt function must be callable (it'll hit our shimmed
  // "no active note" path and notifyError, but it must not throw
  // a ReferenceError from the closure boundary).
  if (rebuiltEncrypt) {
    let threw = null;
    try { await rebuiltEncrypt(); } catch (e) { threw = e; }
    check('rebuilt actionEncryptSelection runs without ReferenceError',
          !(threw && /is not defined/.test(threw.message)),
          threw ? threw.message : '');
  }

  // --- 5. Decrypt action: same boundary test ---
  console.log('\n=== actionDecryptAllInNote body parsed & eval\'d ===');
  const src2 = enc0.actionDecryptAllInNote.toString();
  let rebuiltDecrypt;
  try {
    rebuiltDecrypt = new Function('return ' + src2)();
    check('actionDecryptAllInNote parsed via new Function()', typeof rebuiltDecrypt === 'function');
  } catch (e) {
    check('actionDecryptAllInNote parsed via new Function()', false, e.message);
  }
  if (rebuiltDecrypt) {
    let threw = null;
    try { await rebuiltDecrypt(); } catch (e) { threw = e; }
    check('rebuilt actionDecryptAllInNote runs without ReferenceError',
          !(threw && /is not defined/.test(threw.message)),
          threw ? threw.message : '');
  }

  // --- 6. Direct hotkey (keydown listener) ---
  console.log('\n=== direct hotkey via keydown event ===');
  // Reset the cache and the notify capture
  enc0.cache.clear();
  let hotkeyNotify = null;
  enc0.notify = (m) => { hotkeyNotify = m; };
  // Set a password in the cache so actionForgetCachedPasswords produces a notify.
  enc0.cache.set('h', 'pw');
  // Fire a synthetic CTRL+SHIFT+F keydown event on the document.
  // The hotkey listener should pick it up and dispatch the action.
  let preventDefaultCalled = false;
  let stopPropagationCalled = false;
  global.document.__fireEvent('keydown', {
    key: 'F',
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    target: { tagName: 'DIV' },
    preventDefault() { preventDefaultCalled = true; },
    stopPropagation() { stopPropagationCalled = true; }
  });
  // Yield a tick so the dispatched async action can run
  await new Promise(r => setTimeout(r, 50));
  check('hotkey: action was dispatched (notify fired)', hotkeyNotify === 'Cached ENC0 passwords cleared.',
        'hotkeyNotify=' + JSON.stringify(hotkeyNotify));
  check('hotkey: preventDefault was called', preventDefaultCalled);
  check('hotkey: stopPropagation was called', stopPropagationCalled);
  // Hotkey SHOULD fire even when target is INPUT if a modifier is held
  // (because the user is using a hotkey, not typing).
  hotkeyNotify = null;
  global.document.__fireEvent('keydown', {
    key: 'F', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false,
    target: { tagName: 'INPUT' },
    preventDefault() {}, stopPropagation() {}
  });
  await new Promise(r => setTimeout(r, 50));
  check('hotkey: fires on INPUT when modifier is held', hotkeyNotify === 'Cached ENC0 passwords cleared.',
        'hotkeyNotify=' + JSON.stringify(hotkeyNotify));
  // Same for contenteditable — hotkeys should still fire.
  hotkeyNotify = null;
  global.document.__fireEvent('keydown', {
    key: 'F', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false,
    target: { tagName: 'DIV', isContentEditable: true },
    preventDefault() {}, stopPropagation() {}
  });
  await new Promise(r => setTimeout(r, 50));
  check('hotkey: fires on contenteditable when modifier is held',
        hotkeyNotify === 'Cached ENC0 passwords cleared.',
        'hotkeyNotify=' + JSON.stringify(hotkeyNotify));
  // BUT: plain "F" (no modifier) in an INPUT must NOT fire (avoid hijacking typing).
  hotkeyNotify = null;
  enc0.cache.set('h2', 'pw2'); // give the action something to do
  global.document.__fireEvent('keydown', {
    key: 'F', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
    target: { tagName: 'INPUT' },
    preventDefault() {}, stopPropagation() {}
  });
  await new Promise(r => setTimeout(r, 50));
  check('hotkey: skipped on plain F in INPUT (no modifier)', hotkeyNotify === null);
  // And plain F in contenteditable must NOT fire.
  hotkeyNotify = null;
  global.document.__fireEvent('keydown', {
    key: 'F', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
    target: { tagName: 'DIV', isContentEditable: true },
    preventDefault() {}, stopPropagation() {}
  });
  await new Promise(r => setTimeout(r, 50));
  check('hotkey: skipped on plain F in contenteditable (no modifier)', hotkeyNotify === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('crashed:', e); process.exit(2); });
