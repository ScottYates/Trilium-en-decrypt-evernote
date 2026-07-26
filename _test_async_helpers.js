// Verify the async-aware Trilium API helpers correctly await
// Promises returned by api.getActiveContextNote, note.getContent(),
// and api.getActiveContextTextEditor (modern Trilium returns Promises
// from all of these).

global.window = { matchMedia: () => ({ matches: false }) };
global.document = {
  readyState: 'complete',
  documentElement: { classList: { contains: () => false } },
  head: { appendChild: () => {} },
  body: null,
  querySelectorAll: (sel) => [],
  addEventListener(ev, fn) { (this._listeners = this._listeners || {})[ev] = (this._listeners[ev] || []).concat([fn]); },
  __fireEvent(ev, data) { for (const fn of ((this._listeners && this._listeners[ev]) || [])) fn(data); },
  querySelector: () => null,
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
    Object.defineProperty(el, 'innerHTML', {
      get() { return el._innerHTML || ''; },
      set(html) {
        el._innerHTML = html;
        el._text = String(html || '').replace(/<[^>]*>/g, '');
      }
    });
    Object.defineProperty(el, 'textContent', {
      get() { return el._text || ''; },
      set(v) { el._text = v; }
    });
    Object.defineProperty(el, 'innerText', {
      get() { return el._text || ''; },
      set(v) { el._text = v; }
    });
    return el;
  },
  createTreeWalker: () => ({ nextNode: () => null }),
  getElementById: () => null
};
global.MutationObserver = class { observe() {} };
global.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };

let _noteResolve;
const fakeNote = {
  _content: 'the quick brown fox jumps over the lazy dog',
  _mime: 'text/html',
  getContent: () => Promise.resolve({ content: fakeNote._content, mime: fakeNote._mime }),
  setContent: (text, mime) => { fakeNote._content = text; fakeNote._mime = mime || fakeNote._mime; return Promise.resolve(); }
};
global.api = {
  getActiveContextNote: () => Promise.resolve(fakeNote),
  getActiveContextTextEditor: () => null
};

require('./trilium_enc0.js');
const enc0 = globalThis.__trilium_enc0__;

(async () => {
  let pass = 0, fail = 0;
  function check(name, cond, extra='') {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else      { fail++; console.log('  FAIL  ' + name + '  ' + extra); }
  }

  console.log('\n=== getActiveNote awaits Promise ===');
  const note = await enc0.getActiveNote();
  check('note is the resolved fake', note === fakeNote);

  console.log('\n=== getNoteText unwraps {content, mime} ===');
  const text = await enc0.getNoteText(note);
  check('text is a string', typeof text === 'string');
  check('text equals the .content field', text === 'the quick brown fox jumps over the lazy dog',
        'got ' + JSON.stringify(text));

  console.log('\n=== setNoteText preserves mime ===');
  await enc0.setNoteText(note, 'new content');
  check('content updated', fakeNote._content === 'new content');
  check('mime preserved', fakeNote._mime === 'text/html');

  console.log('\n=== getNoteText accepts string too (backward compat) ===');
  fakeNote._content = 'plain string here';
  fakeNote.getContent = () => 'plain string here';
  const t2 = await enc0.getNoteText(note);
  check('string content accepted', t2 === 'plain string here');

  console.log('\n=== getActiveNote returns null on rejection ===');
  const old = global.api.getActiveContextNote;
  global.api.getActiveContextNote = () => Promise.reject(new Error('boom'));
  const nullNote = await enc0.getActiveNote();
  check('rejection -> null', nullNote === null);
  global.api.getActiveContextNote = old;

  console.log('\n=== actionEncryptSelection with proper async chain ===');
  // Reset content, put a piece of text in the note, "select" it, run action.
  fakeNote._content = 'before SELECTED after';
  fakeNote.getContent = () => Promise.resolve({ content: fakeNote._content, mime: fakeNote._mime });
  fakeNote.setContent = (text, mime) => { fakeNote._content = text; return Promise.resolve(); };
  // Set up a fake editor that "has" SELECTED selected.
  global.api.getActiveContextTextEditor = () => Promise.resolve({
    getSelection: () => 'SELECTED'
  });
  // Stub promptPassword / promptText to skip the modal
  enc0.promptPassword = async () => 'pw';
  enc0.promptText = async () => '';
  enc0.notify = () => {};
  enc0.notifyError = () => {};
  enc0.cache.clear();
  await enc0.actionEncryptSelection();
  check('note content now contains <en-crypt>', /<en-crypt/.test(fakeNote._content), 'got: ' + fakeNote._content);
  check('SELECTED is gone from the note content', !/SELECTED/.test(fakeNote._content));

  console.log('\n=== actionEncryptSelection with Lexical-style editor ===');
  // Reset
  fakeNote._content = 'hello SELECTED world';
  fakeNote.getContent = () => Promise.resolve({ content: fakeNote._content, mime: fakeNote._mime });
  fakeNote.setContent = (text, mime) => { fakeNote._content = text; return Promise.resolve(); };
  // Lexical-style editor: only getSelectedHtml + removeSelection
  global.api.getActiveContextTextEditor = () => Promise.resolve({
    _context: {},
    getSelectedHtml: () => 'SELECTED',
    removeSelection: () => {}
  });
  await enc0.actionEncryptSelection();
  check('Lexical: note content has <en-crypt>', /<en-crypt/.test(fakeNote._content), 'got: ' + fakeNote._content);
  check('Lexical: SELECTED is gone', !/SELECTED/.test(fakeNote._content));

  console.log('\n=== actionEncryptSelection with Lexical getEditorState()._selection ===');
  fakeNote._content = 'foo BAR baz';
  fakeNote.getContent = () => Promise.resolve({ content: fakeNote._content, mime: fakeNote._mime });
  fakeNote.setContent = (text, mime) => { fakeNote._content = text; return Promise.resolve(); };
  global.api.getActiveContextTextEditor = () => Promise.resolve({
    getEditorState: () => ({ _selection: { getTextContent: () => 'BAR' } })
  });
  await enc0.actionEncryptSelection();
  check('Lexical-state: note content has <en-crypt>', /<en-crypt/.test(fakeNote._content), 'got: ' + fakeNote._content);
  check('Lexical-state: BAR is gone', !/BAR/.test(fakeNote._content));

  console.log('\n=== actionDecryptAllInNote: HTML-escaped <en-crypt> ===');
  // Simulate a Lexical note where the <en-crypt> tag was inserted as text
  // and got HTML-escaped on storage.
  const escapedText = 'before &lt;en-crypt cipher="AES" hint="my hint" length="128"&gt;RU5DMC4uLg==&lt;/en-crypt&gt; after';
  // First encrypt a real blob to put in the test
  const realBlob = await enc0.encrypt('the secret', 'pw');
  const realB64 = Buffer.from(realBlob).toString('base64');
  const realEscaped = 'before &lt;en-crypt cipher="AES" hint="my hint" length="128"&gt;' + realB64 + '&lt;/en-crypt&gt; after';
  fakeNote._content = realEscaped;
  fakeNote.getContent = () => Promise.resolve({ content: fakeNote._content, mime: fakeNote._mime });
  fakeNote.setContent = (text, mime) => { fakeNote._content = text; return Promise.resolve(); };
  // Stub prompts to skip the modal
  enc0.promptPassword = async () => 'pw';
  enc0.notify = () => {};
  enc0.notifyError = () => {};
  enc0.cache.clear();
  await enc0.actionDecryptAllInNote();
  check('HTML-escaped decrypt: secret text present', /the secret/.test(fakeNote._content), 'got: ' + fakeNote._content);
  check('HTML-escaped decrypt: en-crypt tag gone', !/en-crypt/.test(fakeNote._content));

  console.log('\n=== _replacePlaceholdersInDomByHint: removed (no longer used) ===');
  check('placeholder replacer was removed', typeof enc0._replacePlaceholdersInDomByHint === 'undefined');

  console.log('\n=== multi-block decrypt (same hint, different plaintexts) ===');
  // Regression for the "all blocks collapse to the first plaintext" bug.
  // Two blocks with the same hint (empty) but different plaintexts should
  // each be replaced with their own plaintext, not both with the first.
  const blob1 = await enc0.encrypt('first secret text', 'pw');
  const blob2 = await enc0.encrypt('second\nsecret\nwith newlines', 'pw');
  const b64_1 = Buffer.from(blob1).toString('base64');
  const b64_2 = Buffer.from(blob2).toString('base64');
  const esc1 = '&lt;en-crypt cipher="AES" hint="" length="128"&gt;' + b64_1 + '&lt;/en-crypt&gt;';
  const esc2 = '&lt;en-crypt cipher="AES" hint="" length="128"&gt;' + b64_2 + '&lt;/en-crypt&gt;';
  // Note: <p> wrapping so the setData path can detect the paragraph context.
  const multiData = '<p>before ' + esc1 + ' middle ' + esc2 + ' after</p>';
  fakeNote._content = multiData;
  fakeNote.getContent = () => Promise.resolve({ content: fakeNote._content, mime: fakeNote._mime });
  fakeNote.setContent = (text, mime) => { fakeNote._content = text; return Promise.resolve(); };
  // Use the helper directly to test the regex / sequential replacement
  // logic without needing a real CKEditor.
  const decodedMulti = multiData
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const fakeEncBlocks = enc0.findEnCrypts(decodedMulti);
  check('multi-block: found 2 blocks', fakeEncBlocks.length === 2,
        'got ' + fakeEncBlocks.length);
  // Now simulate the setData path's sequential replacement
  const plaintexts = [];
  for (const b of fakeEncBlocks) {
    try {
      plaintexts.push(enc0.utf8Decode(await enc0.decrypt(b.blob, 'pw')));
    } catch (e) { plaintexts.push(null); }
  }
  check('multi-block: decrypted both', plaintexts[0] === 'first secret text' && plaintexts[1] === 'second\nsecret\nwith newlines');
  // Now do the actual setData replacement
  enc0.promptPassword = async () => 'pw';
  enc0.notify = () => {};
  enc0.notifyError = () => {};
  enc0.cache.clear();
  // Wire up getActiveTextEditor / getActiveContextTextEditor to a fake CKEditor
  global.api.getActiveContextTextEditor = () => Promise.resolve({
    getData: async () => multiData,
    setData: async (d) => { fakeNote._content = d; },
    getRootElement: () => null
  });
  await enc0.actionDecryptAllInNote();
  // The post-decrypt content should have BOTH plaintexts, not just the first.
  check('multi-block: first plaintext in result', /first secret text/.test(fakeNote._content));
  check('multi-block: second plaintext in result', /second/.test(fakeNote._content));
  check('multi-block: BOTH plaintexts present (different)', fakeNote._content.indexOf('first secret text') !== fakeNote._content.indexOf('second'),
        'firstIdx=' + fakeNote._content.indexOf('first secret text') + ' secondIdx=' + fakeNote._content.indexOf('second'));
  check('multi-block: <en-crypt> tag is gone', !/en-crypt/.test(fakeNote._content));
  // For the inline case, CKEditor 5 normalizes nested <p>s into
  // separate paragraphs at the same level. Assert at minimum that
  // both lines of the second plaintext survive.
  check('multi-block: newlines preserved (second has 3 lines)',
        /second/.test(fakeNote._content) && /secret/.test(fakeNote._content) && /with newlines/.test(fakeNote._content),
        'all three lines should appear: ' + fakeNote._content);
  // Critical: the second <en-crypt> block should also have been
  // replaced (not double-encoded). Look for the literal base64 from
  // b64_2 inside the post-decrypt data — it should be gone.
  check('multi-block: second block was replaced (not double-encoded)',
        fakeNote._content.indexOf(b64_2) === -1,
        'second block still in data: ' + fakeNote._content);

  console.log('\n=== own-<p> decrypt (block is its own <p>) ===');
  // Regression for the "newlines disappear when block is in its own
  // <p>" bug. The decrypted plaintext should produce separate
  // paragraphs, not be flattened to a single line.
  const blob3 = await enc0.encrypt('Account number 6355 0918 741\nRouting number 0730002281', 'pw');
  const b64_3 = Buffer.from(blob3).toString('base64');
  const esc3 = '&lt;en-crypt cipher="AES" hint="" length="128"&gt;' + b64_3 + '&lt;/en-crypt&gt;';
  const ownPData = '<p>before</p><p>' + esc3 + '</p><p>after</p>';
  fakeNote._content = ownPData;
  fakeNote.getContent = () => Promise.resolve({ content: fakeNote._content, mime: fakeNote._mime });
  global.api.getActiveContextTextEditor = () => Promise.resolve({
    getData: async () => ownPData,
    setData: async (d) => { fakeNote._content = d; },
    getRootElement: () => null
  });
  enc0.cache.clear();
  await enc0.actionDecryptAllInNote();
  // The whole <p>...</p> should have been replaced with two <p>s.
  check('own-<p>: both plaintexts present',
        /Account number 6355 0918 741/.test(fakeNote._content) && /Routing number 0730002281/.test(fakeNote._content),
        'got: ' + fakeNote._content);
  check('own-<p>: the encrypted <p> is gone',
        !/en-crypt/.test(fakeNote._content));
  // The new <p>s should appear at top level (not nested inside
  // the original <p>). Match <p with optional attributes.
  check('own-<p>: structure has multiple separate <p>s for the decrypted text',
        (fakeNote._content.match(/<p[\s>]/g) || []).length >= 3,
        'expected at least 3 <p tags in: ' + fakeNote._content);
  // Critical: the two lines should NOT be concatenated on one line.
  // The single concatenated string "741Routing" would indicate failure.
  check('own-<p>: lines are NOT concatenated',
        !/741Routing/.test(fakeNote._content),
        'lines got concatenated in: ' + fakeNote._content);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('crashed:', e); process.exit(2); });
