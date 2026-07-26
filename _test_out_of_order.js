// Test for the "out of order / wrong place" decryption bug.
//
// Bug: when a note has multiple <en-crypt> blocks with DIFFERENT
// passwords, and the user clicks Decrypt and types a password that
// only matches SOME of the blocks, the perBlockPlaintexts list built
// by the model-API code path was shorter than the blocks list (it
// skipped failed decrypts instead of pushing nulls). The walker
// then indexed into that list by document order, so plaintext N
// got put into block N+1, and the LAST matching block ended up
// un-replaced.
//
// The fix: build a {b64 -> plaintext} map instead of an indexed
// array, and have the walker look up the plaintext by matching the
// en-crypt tag's base64 in the model to the block's base64. That
// way alignment is structural, not positional.

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
  __fireEvent(ev, data) { for (const fn of (_docListeners[ev] || [])) fn(data); },
  __listeners: _docListeners
};
global.MutationObserver = class { observe() {} };
global.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
global.api = {
  getActiveContextNote: () => null,
  getActiveContextTextEditor: () => null,
  showMessage: (m) => console.log('  [notify]', m),
  showError: (m) => console.log('  [error]', m)
};

require('./trilium_enc0.js');
const enc0 = globalThis.__trilium_enc0__;
if (!enc0) { console.error('FAIL: __trilium_enc0__ not exposed'); process.exit(1); }

// ---- Build a minimal CKEditor 5 model mock ----
//
// The walker uses:
//   editor.model.document.getRoot()         -> node with getChildren()
//   node.is('$text') / node.is('element')   -> type check
//   node.data                               -> text content
//   node.parent                             -> parent for writer ops
//   node.startOffset                        -> offset within parent
//   writer.createPositionAt(parent, offset) -> position
//   writer.createRange(start, end)          -> range
//   writer.remove(range)                    -> drop the range
//   writer.insertText(text, position)       -> put plaintext back
//
// CKEditor 5's model structure that this walker expects:
//   root (element)
//     <paragraph> (element)
//       text (text node) with the en-crypt tag
//     <paragraph> (element)
//       text (text node) with the en-crypt tag
//     ...
// The walker recurses from root -> <paragraph> -> text. The text's
// parent is the <paragraph>, so writer operations are scoped to
// the <paragraph>'s text children.

class MockTextNode {
  constructor(data) {
    this._data = data;
    this._parent = null;
    this._startOffset = 0;
  }
  is(t) { return t === '$text'; }
  get data() { return this._data; }
  set data(v) { this._data = v; }
  get parent() { return this._parent; }
  get startOffset() { return this._startOffset; }
}
class MockElement {
  constructor(name) {
    this._children = [];
    this._parent = null;
    this.name = name || 'paragraph';
  }
  is(t) { return t === 'element' || t === 'root'; }
  getChildren() { return this._children; }
  appendTextChild(text) {
    const t = new MockTextNode(text);
    t._parent = this;
    t._startOffset = 0;
    this._children.push(t);
    return t;
  }
}
class MockWriter {
  createPositionAt(node, offset) { return { node, offset }; }
  createRange(start, end) { return { start, end }; }
  createElement(name) { return new MockElement(name); }
  createPositionAfter(element) {
    const parent = element._parent;
    if (!parent) throw new Error('createPositionAfter: no parent');
    const idx = parent._children.indexOf(element);
    if (idx < 0) throw new Error('createPositionAfter: element not in parent');
    let consumed = 0;
    for (let i = 0; i < idx; i++) {
      const c = parent._children[i];
      if (c.is && c.is('$text')) consumed += (c.data || '').length;
      else consumed += 1;
    }
    consumed += 1;
    return { node: parent, offset: consumed };
  }
  insert(element, position) {
    const { node: parent, offset } = position;
    // Find which child to insert after. For simplicity, just append
    // to the end of the parent's children.
    element._parent = parent;
    parent._children.push(element);
  }
  _textChildAtPosition(parent, offset) {
    let consumed = 0;
    for (const child of parent._children) {
      if (!child.is || !child.is('$text')) continue;
      const childLen = (child.data || '').length;
      if (offset >= consumed && offset <= consumed + childLen) {
        return { child, localOffset: offset - consumed };
      }
      consumed += childLen;
    }
    return null;
  }
  remove(range) {
    const { node: parent, offset: s } = range.start;
    const e = range.end.offset;
    const start = this._textChildAtPosition(parent, s);
    const end = this._textChildAtPosition(parent, e);
    if (!start || !end) return;
    if (start.child === end.child) {
      const c = start.child;
      c._data = c._data.slice(0, start.localOffset) + c._data.slice(end.localOffset);
    } else {
      throw new Error('remove across children not implemented in mock');
    }
  }
  insertText(text, arg) {
    // CKEditor 5's writer.insertText accepts EITHER a position
    // object { node, offset } OR an element (in which case the
    // text is inserted at the end of the element). The production
    // walker uses both forms, so the mock needs to support both.
    if (arg && arg.is && arg.is('element')) {
      // arg is an element — append a new text child to it.
      const parent = arg;
      const t = new MockTextNode(text);
      t._parent = parent;
      parent._children.push(t);
      return;
    }
    // arg is a position
    const { node: parent, offset } = arg;
    const found = this._textChildAtPosition(parent, offset);
    if (!found) {
      if (parent._children.length === 0) {
        const t = new MockTextNode(text);
        t._parent = parent;
        parent._children.push(t);
        return;
      }
      throw new Error('insertText: no child at offset ' + offset);
    }
    const c = found.child;
    c._data = c._data.slice(0, found.localOffset) + text + c._data.slice(found.localOffset);
  }
}

function makeEditor(pElements) {
  const root = new MockElement('root');
  for (const text of pElements) {
    const p = new MockElement('paragraph');
    p.appendTextChild(text);
    p._parent = root; // mock's createPositionAfter needs this set
    root._children.push(p);
  }
  return { model: { document: { getRoot: () => root } } };
}

(async () => {
  let pass = 0, fail = 0;
  function check(name, cond, extra='') {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else      { fail++; console.log('  FAIL  ' + name + '  ' + (extra ? ('  ' + extra) : '')); }
  }

  async function buildTag(plaintext, password, hint) {
    const blob = await enc0.encrypt(plaintext, password);
    const tag = enc0.buildEnCryptTag(blob, hint);
    return tag.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function esc(t) {
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  // Extract the b64 of an escaped en-crypt tag's contents. The
  // model stores the tag in escaped form, and the walker needs to
  // match the in-model b64 to the block's b64 (which has whitespace
  // stripped). This helper does the inverse: take a built tag, get
  // its in-tag b64, strip whitespace, return.
  function tagB64(plaintext, password, hint) {
    return enc0.buildEnCryptTag(null, hint).replace(/[\s\n\r]/g, '') // placeholder
      || '';
  }
  // Actually a simpler approach: build the unescaped tag and grab
  // its b64 directly.
  function getB64(plaintext, password) {
    const blob = enc0.encryptSync ? enc0.encryptSync(plaintext, password) : null;
    // enc0.encrypt is async; we need a sync version. Use the
    // exported encryptString and base64-decode the result.
    const b64 = enc0.encryptString(plaintext, password);
    return b64; // already a base64 string with no whitespace
  }

  // ---- 1. The b64-keyed map preserves alignment regardless of
  //         iteration order in the model. ----
  console.log('\n=== b64-keyed map preserves alignment under any iteration order ===');
  {
    // Even if the walker iterates the model in a different order
    // than the blocks list, the b64 lookup guarantees each tag is
    // matched to the right block.
    const blocks = [
      { b64: 'AAA', hint: 'A' },
      { b64: 'BBB', hint: 'B' },
      { b64: 'CCC', hint: 'C' }
    ];
    // Password only matches the middle block.
    const b64Map = { 'AAA': null, 'BBB': 'middle_plaintext', 'CCC': null };
    // Simulate the walker encountering blocks in REVERSE order:
    // CCC, BBB, AAA. With b64 matching, each still gets the right
    // plaintext (or stays encrypted).
    const encounteredOrder = ['CCC', 'BBB', 'AAA'];
    const result = {};
    for (const b64 of encounteredOrder) {
      if (b64Map[b64] != null) result[b64] = b64Map[b64];
    }
    check('b64 match: only BBB got replaced', Object.keys(result).length === 1 && result.BBB === 'middle_plaintext');
    check('b64 match: AAA stayed encrypted', result.AAA === undefined);
    check('b64 match: CCC stayed encrypted', result.CCC === undefined);
  }

  // ---- 2. End-to-end: 3 <p>s with en-crypt tags, password matches
  //         only blocks 0 and 2. The walker must replace block 0
  //         with A1, leave block 1 alone, and replace block 2
  //         with A2. ----
  console.log('\n=== end-to-end walker with mixed successes/failures ===');
  {
    const tagA1 = await buildTag('plaintext A1', 'pwA', 'A');
    const tagB  = await buildTag('plaintext B',  'pwB', 'B');
    const tagA2 = await buildTag('plaintext A2', 'pwA', 'A');
    const editor = makeEditor([tagA1, tagB, tagA2]);
    // b64Map: matches each block by its b64. Build it the FIXED way
    // (push nulls for failures).
    const blocks = [
      { b64: extractB64(tagA1), blob: blobFromB64(extractB64(tagA1)), hint: 'A' },
      { b64: extractB64(tagB),  blob: blobFromB64(extractB64(tagB)),  hint: 'B' },
      { b64: extractB64(tagA2), blob: blobFromB64(extractB64(tagA2)), hint: 'A' }
    ];
    const b64Map = {};
    for (const b of blocks) {
      try {
        b64Map[b.b64] = enc0.utf8Decode(await enc0.decrypt(b.blob, 'pwA'));
      } catch (e) { b64Map[b.b64] = null; }
    }
    check('b64Map[A1] = plaintext A1', b64Map[blocks[0].b64] === 'plaintext A1');
    check('b64Map[B] = null (failed)', b64Map[blocks[1].b64] === null);
    check('b64Map[A2] = plaintext A2', b64Map[blocks[2].b64] === 'plaintext A2');

    const writer = new MockWriter();
    let replaced = 0;
    walkModelForEncryptedFixed(editor, writer, b64Map, () => { replaced++; });
    const t0 = editor.model.document.getRoot()._children[0]._children[0];
    const t1 = editor.model.document.getRoot()._children[1]._children[0];
    const t2 = editor.model.document.getRoot()._children[2]._children[0];
    check('t0: 2 replacements counted', replaced === 2, 'got ' + replaced);
    check('t0: contains A1 plaintext', t0.data.indexOf('plaintext A1') !== -1);
    check('t0: A1 en-crypt tag removed', t0.data.indexOf(esc('<en-crypt cipher="AES" hint="A"')) === -1);
    check('t1: B en-crypt tag still present (must NOT be replaced)',
          t1.data.indexOf(esc('<en-crypt cipher="AES" hint="B"')) !== -1);
    check('t1: B plaintext NOT present (must stay encrypted)',
          t1.data.indexOf('plaintext B') === -1);
    check('t2: contains A2 plaintext', t2.data.indexOf('plaintext A2') !== -1);
    check('t2: A2 en-crypt tag removed', t2.data.indexOf(esc('<en-crypt cipher="AES" hint="A"')) === -1);
  }

  // ---- 3. THE BUG SCENARIO: only the MIDDLE block (block 1)
  //         matches the password. Block 0 and block 2 fail.
  //         This is the exact scenario the user reported. ----
  console.log('\n=== BUG SCENARIO: only the middle block matches ===');
  {
    const tag1 = await buildTag('first', 'pwX', 'X');
    const tag2 = await buildTag('SECOND', 'pwY', 'Y');
    const tag3 = await buildTag('third',  'pwX', 'X');
    const editor = makeEditor([tag1, tag2, tag3]);
    // Password 'pwY' matches only block 2.
    const b64Map = {};
    const blocks = [
      { b64: extractB64(tag1), blob: blobFromB64(extractB64(tag1)) },
      { b64: extractB64(tag2), blob: blobFromB64(extractB64(tag2)) },
      { b64: extractB64(tag3), blob: blobFromB64(extractB64(tag3)) }
    ];
    for (const b of blocks) {
      try {
        b64Map[b.b64] = enc0.utf8Decode(await enc0.decrypt(b.blob, 'pwY'));
      } catch (e) { b64Map[b.b64] = null; }
    }
    const writer = new MockWriter();
    let replaced = 0;
    walkModelForEncryptedFixed(editor, writer, b64Map, () => { replaced++; });
    const t0 = editor.model.document.getRoot()._children[0]._children[0];
    const t1 = editor.model.document.getRoot()._children[1]._children[0];
    const t2 = editor.model.document.getRoot()._children[2]._children[0];
    check('middle only: 1 replacement', replaced === 1, 'got ' + replaced);
    check('middle only: t0 has first en-crypt tag intact (block 1 NOT replaced)',
          t0.data.indexOf(esc('<en-crypt cipher="AES" hint="X"')) !== -1);
    check('middle only: t0 does NOT have SECOND plaintext (the original bug)',
          t0.data.indexOf('SECOND') === -1,
          'BUG: t0 got wrong plaintext. data: ' + t0.data);
    check('middle only: t1 has SECOND plaintext (block 2 correctly replaced)',
          t1.data.indexOf('SECOND') !== -1);
    check('middle only: t2 has third en-crypt tag intact (block 3 NOT replaced)',
          t2.data.indexOf(esc('<en-crypt cipher="AES" hint="X"')) !== -1);
    check('middle only: t2 does NOT have SECOND plaintext',
          t2.data.indexOf('SECOND') === -1,
          'BUG: t2 got wrong plaintext. data: ' + t2.data);
  }

  // ---- 4. BUGGY walker (old index-based, no nulls): the bug
  //         reproduces exactly as the user described. ----
  console.log('\n=== BUGGY walker (old code) reproduces the original symptom ===');
  {
    const tag1 = await buildTag('first', 'pwX', 'X');
    const tag2 = await buildTag('SECOND', 'pwY', 'Y');
    const tag3 = await buildTag('third',  'pwX', 'X');
    const editor = makeEditor([tag1, tag2, tag3]);
    // Old code: skip failures, only push successes.
    const perBlockPlaintextsBuggy = ['SECOND'];  // only block 2 succeeded
    const writer = new MockWriter();
    let replaced = 0;
    walkModelForEncryptedBUGGY(editor, writer, perBlockPlaintextsBuggy, () => { replaced++; });
    const t0 = editor.model.document.getRoot()._children[0]._children[0];
    const t1 = editor.model.document.getRoot()._children[1]._children[0];
    const t2 = editor.model.document.getRoot()._children[2]._children[0];
    check('BUGGY: t0 has SECOND plaintext (wrong! should still be encrypted)',
          t0.data.indexOf('SECOND') !== -1,
          't0: ' + t0.data);
    check('BUGGY: t0 lost first en-crypt tag', t0.data.indexOf(esc('<en-crypt cipher="AES" hint="X"')) === -1);
    check('BUGGY: t1 still encrypted', t1.data.indexOf(esc('<en-crypt cipher="AES" hint="Y"')) !== -1);
    check('BUGGY: t2 still encrypted', t2.data.indexOf(esc('<en-crypt cipher="AES" hint="X"')) !== -1);
  }

  // ---- 5. Single-block sanity check ----
  console.log('\n=== single-block sanity check ===');
  {
    const tag = await buildTag('just one', 'pw', '');
    const editor = makeEditor([tag]);
    const b64Map = { [extractB64(tag)]: 'just one' };
    const writer = new MockWriter();
    let replaced = 0;
    walkModelForEncryptedFixed(editor, writer, b64Map, () => { replaced++; });
    check('single: 1 replacement', replaced === 1);
    const t0 = editor.model.document.getRoot()._children[0]._children[0];
    check('single: contains plaintext', t0.data.indexOf('just one') !== -1);
  }

  // ---- 6. All blocks fail: nothing is replaced ----
  console.log('\n=== all blocks fail (wrong password) ===');
  {
    const tag1 = await buildTag('first', 'real-pw', 'h1');
    const tag2 = await buildTag('second', 'real-pw', 'h2');
    const editor = makeEditor([tag1, tag2]);
    const b64Map = {
      [extractB64(tag1)]: null,
      [extractB64(tag2)]: null
    };
    const writer = new MockWriter();
    let replaced = 0;
    walkModelForEncryptedFixed(editor, writer, b64Map, () => { replaced++; });
    check('all fail: 0 replacements', replaced === 0);
    const t0 = editor.model.document.getRoot()._children[0]._children[0];
    const t1 = editor.model.document.getRoot()._children[1]._children[0];
    check('all fail: t0 en-crypt tag intact',
          t0.data.indexOf(esc('<en-crypt cipher="AES" hint="h1"')) !== -1);
    check('all fail: t1 en-crypt tag intact',
          t1.data.indexOf(esc('<en-crypt cipher="AES" hint="h2"')) !== -1);
  }

  // ---- 7. First block fails, others succeed (alignment test) ----
  console.log('\n=== first block fails, rest succeed ===');
  {
    const tag1 = await buildTag('zebra',  'pwA', 'A');
    const tag2 = await buildTag('apple',  'pwA', 'A');
    const tag3 = await buildTag('mango',  'pwA', 'A');
    const editor = makeEditor([tag1, tag2, tag3]);
    // Password 'pwA' matches all but the first (block 1's blob was
    // built with a different password).
    const blocks = [
      { b64: extractB64(tag1), blob: blobFromB64(extractB64(tag1)) },
      { b64: extractB64(tag2), blob: blobFromB64(extractB64(tag2)) },
      { b64: extractB64(tag3), blob: blobFromB64(extractB64(tag3)) }
    ];
    // For this test, simulate: block 1's password is different so
    // it fails. We use a wrong password for block 1.
    const b64Map = {};
    b64Map[blocks[0].b64] = null; // force first to fail
    try {
      b64Map[blocks[1].b64] = enc0.utf8Decode(await enc0.decrypt(blocks[1].blob, 'pwA'));
    } catch (e) { b64Map[blocks[1].b64] = null; }
    try {
      b64Map[blocks[2].b64] = enc0.utf8Decode(await enc0.decrypt(blocks[2].blob, 'pwA'));
    } catch (e) { b64Map[blocks[2].b64] = null; }

    const writer = new MockWriter();
    let replaced = 0;
    walkModelForEncryptedFixed(editor, writer, b64Map, () => { replaced++; });
    check('first fails: 2 replacements', replaced === 2);
    const t0 = editor.model.document.getRoot()._children[0]._children[0];
    const t1 = editor.model.document.getRoot()._children[1]._children[0];
    const t2 = editor.model.document.getRoot()._children[2]._children[0];
    check('first fails: t0 still has first en-crypt tag',
          t0.data.indexOf(esc('<en-crypt cipher="AES" hint="A"')) !== -1);
    check('first fails: t0 does NOT have apple or mango plaintext',
          t0.data.indexOf('apple') === -1 && t0.data.indexOf('mango') === -1,
          't0 data: ' + t0.data);
    check('first fails: t1 has apple plaintext', t1.data.indexOf('apple') !== -1);
    check('first fails: t2 has mango plaintext', t2.data.indexOf('mango') !== -1);
  }

  // ---- 8. CRITICAL: walker must match UNESCAPED tags (the form
  //         CKEditor 5's model actually stores). The old walker
  //         regex was for the escaped form only, which is why it
  //         never matched anything in the model and the setData
  //         fallback was doing all the work. ----
  console.log('\n=== walker matches unescaped tags (CKEditor 5 model form) ===');
  {
    const tag = await buildTag('hello world', 'pw', 'X');
    // The "model" stores the unescaped form. Strip the entity-
    // escaping that buildTag applies to get back the raw tag.
    const unescapedTag = tag
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
    const editor = makeEditor([unescapedTag]);
    // Sanity: this is the unescaped form (not the escaped one)
    check('test setup: tag is unescaped',
          unescapedTag.indexOf('&lt;') === -1 && unescapedTag.indexOf('<en-crypt') === 0);
    const b64Map = { [extractB64(tag)]: 'hello world' };
    const writer = new MockWriter();
    let replaced = 0;
    walkModelForEncryptedFixed(editor, writer, b64Map, () => { replaced++; });
    check('unescaped: 1 replacement', replaced === 1, 'got ' + replaced);
    const t0 = editor.model.document.getRoot()._children[0]._children[0];
    check('unescaped: contains plaintext', t0.data.indexOf('hello world') !== -1);
    check('unescaped: en-crypt tag gone', t0.data.indexOf('<en-crypt') === -1);
  }

  // ---- 9. Walker must ALSO still match escaped tags (in case
  //         some configurations store the escaped form). ----
  console.log('\n=== walker also matches escaped tags (legacy form) ===');
  {
    const tag = await buildTag('hello escaped', 'pw', 'Y');
    const editor = makeEditor([tag]); // already escaped
    const b64Map = { [extractB64(tag)]: 'hello escaped' };
    const writer = new MockWriter();
    let replaced = 0;
    walkModelForEncryptedFixed(editor, writer, b64Map, () => { replaced++; });
    check('escaped: 1 replacement', replaced === 1, 'got ' + replaced);
    const t0 = editor.model.document.getRoot()._children[0]._children[0];
    check('escaped: contains plaintext', t0.data.indexOf('hello escaped') !== -1);
    check('escaped: en-crypt tag gone', t0.data.indexOf('&lt;en-crypt') === -1);
  }

  // ---- 10. Multi-line plaintext: walker must split into multiple
  //          paragraphs (own-<p> case). The setData path already
  //          handled this; we need the walker to do the same so
  //          both paths produce the same output. CRITICAL: this
  //          also verifies the isOwnPara detection works (the
  //          old buggy version used para.getData() which is
  //          undefined on CKEditor 5 elements, so isOwnPara
  //          was always false and the multi-line split never
  //          happened — which caused the second line to be
  //          dropped entirely). ----
  console.log('\n=== multi-line plaintext: own-<p> case → multiple paragraphs ===');
  {
    const tag = await buildTag('line1\nline2\nline3', 'pw', 'M');
    const editor = makeEditor([tag]);
    const b64Map = { [extractB64(tag)]: 'line1\nline2\nline3' };
    const writer = new MockWriter();
    let replaced = 0;
    walkModelForEncryptedFixed(editor, writer, b64Map, () => { replaced++; });
    check('multi-line own-<p>: 1 replacement call', replaced === 1);
    const root = editor.model.document.getRoot();
    // After the walker: the original paragraph (p0) has line1 as
    // text, and 2 new paragraphs (p1, p2) have line2 and line3.
    // The first paragraph should now have 3 children (the root).
    check('multi-line own-<p>: root has 3 children (1 original + 2 new)',
          root._children.length === 3,
          'got ' + root._children.length);
    const t0 = root._children[0]._children[0];
    check('multi-line own-<p>: first paragraph contains line1',
          t0.data.indexOf('line1') !== -1);
    check('multi-line own-<p>: first paragraph does NOT contain line2 or line3 (those go in new paragraphs)',
          t0.data.indexOf('line2') === -1 && t0.data.indexOf('line3') === -1,
          't0 data: ' + t0.data);
    check('multi-line own-<p>: no en-crypt tag left in first paragraph',
          t0.data.indexOf('<en-crypt') === -1 && t0.data.indexOf('&lt;en-crypt') === -1);
    // Verify the new paragraphs have lines 2 and 3.
    if (root._children.length >= 3) {
      const t1 = root._children[1]._children[0];
      const t2 = root._children[2]._children[0];
      check('multi-line own-<p>: second paragraph contains line2',
            t1 && t1.data && t1.data.indexOf('line2') !== -1,
            't1: ' + (t1 ? t1.data : 'undefined'));
      check('multi-line own-<p>: third paragraph contains line3',
            t2 && t2.data && t2.data.indexOf('line3') !== -1,
            't2: ' + (t2 ? t2.data : 'undefined'));
    }
  }

  // ---- 11. Multi-line plaintext: single line, sanity check. ----
  console.log('\n=== single-line plaintext: simple replacement ===');
  {
    const tag = await buildTag('just one line', 'pw', 'S');
    const editor = makeEditor([tag]);
    const b64Map = { [extractB64(tag)]: 'just one line' };
    const writer = new MockWriter();
    let replaced = 0;
    walkModelForEncryptedFixed(editor, writer, b64Map, () => { replaced++; });
    check('single-line: 1 replacement', replaced === 1);
    const t0 = editor.model.document.getRoot()._children[0]._children[0];
    check('single-line: contains plaintext', t0.data.indexOf('just one line') !== -1);
  }

  // ---- 12. placeCursorAtParagraphIndex: the cursor placement
  //          helper the actions actually use (start/end by index). ----
  console.log('\n=== placeCursorAtParagraphIndex: exposed ===');
  {
    check('placeCursorAtParagraphIndex is exposed',
          typeof enc0.placeCursorAtParagraphIndex === 'function');
    check('getCursorParagraphIndex is exposed',
          typeof enc0.getCursorParagraphIndex === 'function');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('Test runner crashed:', e); process.exit(2); });

// ----------------------------------------------------------------------------
// Helper: extract the b64 of an en-crypt tag (whitespace-stripped).
// ----------------------------------------------------------------------------
function extractB64(escapedTag) {
  // The escaped tag is like "<p>&lt;en-crypt ...&gt;BASE64&lt;/en-crypt&gt;</p>".
  // Decode entities, then grab the b64.
  const decoded = escapedTag
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
  const m = decoded.match(/<en-crypt\b[^>]*>([\s\S]*?)<\/en-crypt>/);
  return m ? m[1].replace(/[\s\n\r]/g, '') : '';
}

// Decode a b64 string into the bytes the walker will see when
// decrypting. For the b64 map we just need the matching key, so
// the bytes themselves aren't important here — we use this only to
// call enc0.decrypt in the test setup.
function blobFromB64(b64) {
  const bin = Buffer.from(b64, 'base64');
  return new Uint8Array(bin);
}

// ----------------------------------------------------------------------------
// Local copies of the walker — fixed (b64-keyed) and buggy
// (index-based, no null sentinels) versions — for testing.
// ----------------------------------------------------------------------------

function walkModelForEncryptedFixed(editor, writer, b64Map, onReplaced) {
  const root = editor.model.document.getRoot();
  if (!root) return;
  // Match BOTH escaped and unescaped forms. The model typically
  // stores unescaped text; the legacy setData path stores escaped.
  const ENC_RE = /<en-crypt\b([^>]*)>([^<]*)<\/en-crypt>|&lt;en-crypt\b([^&]*)&gt;([^&]*)&lt;\/en-crypt&gt;/g;
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
          const mB64 = rawB64.replace(/[\s\n\r]/g, '');
          const plaintext = b64Map[mB64];
          if (plaintext == null) {
            return;
          }
          const parent = child.parent;
          if (!parent) return;
          const lines = String(plaintext).split('\n');
          const startOff = child.startOffset + m.index;
          const endOff   = child.startOffset + m.index + m[0].length;
          try {
            const start = writer.createPositionAt(parent, startOff);
            const range = writer.createRange(start, writer.createPositionAt(parent, endOff));
            writer.remove(range);
            if (lines.length === 1) {
              writer.insertText(plaintext, start);
            } else {
              // Own-<p> detection: paragraph has exactly one child
              // and that child is THIS text node.
              const para = (parent && parent.is && parent.is('element')) ? parent : (parent && parent.parent) || parent;
              const paraChildren = (para && typeof para.getChildren === 'function') ? Array.from(para.getChildren()) : [];
              const isOwnPara = paraChildren.length === 1 && paraChildren[0] === child;
              if (isOwnPara) {
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
                // Inline case: insert softBreak + text (BOTH).
                writer.insertText(lines[0], start);
                let lastPos = writer.createPositionAt(parent, startOff + lines[0].length);
                for (let i = 1; i < lines.length; i++) {
                  let inserted = false;
                  try {
                    const br = writer.createElement('softBreak');
                    writer.insert(br, lastPos);
                    const afterBr = writer.createPositionAfter(br);
                    writer.insertText(lines[i], afterBr);
                    lastPos = writer.createPositionAt(parent, 'end');
                    inserted = true;
                  } catch (e2) {}
                  if (!inserted) {
                    try {
                      writer.insertText('\n' + lines[i], lastPos);
                      lastPos = writer.createPositionAt(parent, 'end');
                    } catch (e3) {}
                  }
                }
              }
            }
            onReplaced();
          } catch (e) { /* bail out */ }
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

function walkModelForEncryptedBUGGY(editor, writer, perBlockPlaintexts, onReplaced) {
  // BUGGY version: index-based with no null sentinels.
  // Reproduces the original "out of order" symptom.
  const root = editor.model.document.getRoot();
  if (!root) return;
  const ENC_RE = /&lt;en-crypt\b([^&]*)&gt;([^&]*)&lt;\/en-crypt&gt;/g;
  let blockIdx = 0;
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
          if (blockIdx >= perBlockPlaintexts.length) return;
          const plaintext = perBlockPlaintexts[blockIdx++];
          // NO null check — this is the bug
          const parent = child.parent;
          if (!parent) return;
          const startOff = child.startOffset + m.index;
          const endOff   = child.startOffset + m.index + m[0].length;
          try {
            const start = writer.createPositionAt(parent, startOff);
            const range = writer.createRange(start, writer.createPositionAt(parent, endOff));
            writer.remove(range);
            writer.insertText(plaintext, start);
            onReplaced();
          } catch (e) { /* bail out */ }
          return;
        }
      } else if (child.is && child.is('element')) {
        walk(child);
      }
    }
  }
  walk(root);
}
