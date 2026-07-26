// Sanity test: confirm the custom DOM modal works against a minimal
// document.body shim. We don't simulate user typing — just that
// calling the action body no longer crashes on prompt().

global.window = { matchMedia: () => ({ matches: false }) };
global.document = {
  readyState: 'complete',
  documentElement: { classList: { contains: () => false } },
  head: { appendChild: () => {} },
  body: {
    appendChild: (el) => { global.document.body._last = el; },
    removeChild: (el) => { if (global.document.body._last === el) global.document.body._last = null; }
  },
  addEventListener(ev, fn) { (this._listeners = this._listeners || {})[ev] = (this._listeners[ev] || []).concat([fn]); },
  __fireEvent(ev, data) { for (const fn of ((this._listeners && this._listeners[ev]) || [])) fn(data); },
  createElement: (tag) => {
    const el = {
      tagName: tag.toUpperCase(),
      style: {},
      classList: { add: () => {}, contains: () => false },
      children: [],
      _listeners: {},
      appendChild(c) { this.children.push(c); return c; },
      removeChild(c) { this.children = this.children.filter(x => x !== c); return c; },
      addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
      setAttribute() {},
      focus() {}, select() {}
    };
    Object.defineProperty(el, 'value', {
      get() { return el._value || ''; },
      set(v) { el._value = v; }
    });
    Object.defineProperty(el, 'textContent', {
      get() { return el._text || ''; },
      set(v) { el._text = v; }
    });
    return el;
  },
  createTreeWalker: () => ({ nextNode: () => null, currentNode: { nodeType: 3, parentNode: null } }),
  getElementById: () => null
};
global.MutationObserver = class { observe() {} };
global.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };

require('./trilium_enc0.js');
const enc0 = globalThis.__trilium_enc0__;

(async () => {
  let pass = 0, fail = 0;
  function check(name, cond) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else      { fail++; console.log('  FAIL  ' + name); }
  }

  // buildPromptModal is exposed? (not directly, but we can test via the public shims)
  // The action calls promptPassword -> buildPromptModal. With no api.dialog, it
  // should resolve with the input value (or null on cancel).

  // We can't easily simulate user typing in this stub, but we CAN
  // verify the modal element gets created on the body and that
  // clicking the OK button resolves the promise.

  console.log('\n=== buildPromptModal creates a DOM element ===');
  let modal = null;
  // Monkey-patch appendChild to capture the overlay
  const origAppend = global.document.body.appendChild;
  global.document.body.appendChild = function(el) { modal = el; return origAppend.call(this, el); };
  const p = enc0.promptPassword('test message');
  // Yield so the Promise constructor can run
  await new Promise(r => setImmediate(r));
  check('modal was appended to body', modal !== null);
  // Simulate clicking OK with value "secret"
  if (modal) {
    const box = modal.children[0];
    const input = box.children.find(c => c.tagName === 'INPUT');
    const row = box.children[box.children.length - 1];
    const okBtn = row.children[1]; // last button in row
    input._value = 'secret';
    okBtn._listeners.click[0]();
    const result = await p;
    check('OK click resolves with input value', result === 'secret');
    check('modal removed from body after close', global.document.body._last === null);
  }
  global.document.body.appendChild = origAppend;

  console.log('\n=== Cancel resolves with null ===');
  modal = null;
  const p2 = enc0.promptPassword('msg');
  await new Promise(r => setImmediate(r));
  if (modal) {
    const box = modal.children[0];
    const row = box.children[box.children.length - 1];
    const cancelBtn = row.children[0];
    cancelBtn._listeners.click[0]();
    const result = await p2;
    check('Cancel click resolves with null', result === null);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('crashed:', e); process.exit(2); });
