// Tests for actionWrapEnCryptBlobs: find raw ENC0 base64 in note text
// and wrap it in <en-crypt> tags.

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
global.api = { getActiveContextTextEditor: () => null };

require('./trilium_enc0.js');
const enc0 = globalThis.__trilium_enc0__ || global.window.__trilium_enc0__;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

(async () => {
  // Helper: encrypt some text to get a real b64 blob
  const realBlob = await enc0.encrypt('hello world this is a test', 'pw');
  const realB64 = Buffer.from(realBlob).toString('base64');
  console.log('(test b64 length:', realB64.length + ')');

  // ---- 1. The function is exposed ----
  console.log('\n=== exposed ===');
  check('actionWrapEnCryptBlobs is exposed',
        typeof enc0.actionWrapEnCryptBlobs === 'function');

  // ---- 2. Single blob in plain text gets wrapped ----
  console.log('\n=== single blob in plain text ===');
  {
    const fakeNote = {
      _content: 'before text\n' + realB64 + '\nafter text',
      getContent: () => Promise.resolve({ content: fakeNote._content, mime: fakeNote._mime }),
      setContent: (text, mime) => { fakeNote._content = text; return Promise.resolve(); }
    };
    enc0.getActiveNote = async () => fakeNote;
    enc0.notify = (m) => console.log('  notify:', m);
    enc0.notifyError = (m) => console.log('  notifyErr:', m);
    await enc0.actionWrapEnCryptBlobs();
    check('blob is now wrapped in <en-crypt>',
          /<en-crypt cipher="AES" hint="" length="128">RU5DM/.test(fakeNote._content));
    check('surrounding text preserved',
          fakeNote._content.indexOf('before text') === 0 &&
          fakeNote._content.indexOf('after text') > 0);
  }

  // ---- 3. Multiple blobs in one note all get wrapped ----
  console.log('\n=== multiple blobs ===');
  {
    const realBlob2 = await enc0.encrypt('second blob content', 'pw');
    const realB64_2 = Buffer.from(realBlob2).toString('base64');
    const fakeNote = {
      _content: 'first ' + realB64 + ' middle ' + realB64_2 + ' end',
      getContent: () => Promise.resolve({ content: fakeNote._content, mime: fakeNote._mime }),
      setContent: (text, mime) => { fakeNote._content = text; return Promise.resolve(); }
    };
    enc0.getActiveNote = async () => fakeNote;
    enc0.notify = () => {};
    enc0.notifyError = () => {};
    await enc0.actionWrapEnCryptBlobs();
    const wraps = (fakeNote._content.match(/<en-crypt cipher="AES" hint="" length="128">/g) || []).length;
    check('both blobs wrapped', wraps === 2, 'got ' + wraps + ' wraps');
    check('first blob is one of the two',
          fakeNote._content.indexOf(realB64) !== -1);
    check('second blob is one of the two',
          fakeNote._content.indexOf(realB64_2) !== -1);
  }

  // ---- 4. Already-wrapped blob is not double-wrapped ----
  console.log('\n=== already wrapped is skipped ===');
  {
    const wrapped = '<en-crypt cipher="AES" hint="" length="128">' + realB64 + '</en-crypt>';
    const fakeNote = {
      _content: 'before ' + wrapped + ' after',
      getContent: () => Promise.resolve({ content: fakeNote._content, mime: fakeNote._mime }),
      setContent: (text, mime) => { fakeNote._content = text; return Promise.resolve(); }
    };
    enc0.getActiveNote = async () => fakeNote;
    enc0.notify = (m) => console.log('  notify:', m);
    enc0.notifyError = () => {};
    await enc0.actionWrapEnCryptBlobs();
    const wraps = (fakeNote._content.match(/<en-crypt cipher="AES" hint="" length="128">/g) || []).length;
    check('still exactly one wrap', wraps === 1, 'got ' + wraps);
    check('content unchanged',
          fakeNote._content === 'before ' + wrapped + ' after');
  }

  // ---- 5. No blobs in note — no-op with notification ----
  console.log('\n=== no blobs ===');
  {
    const fakeNote = {
      _content: 'just a plain text note with no encrypted content',
      getContent: () => Promise.resolve({ content: fakeNote._content, mime: fakeNote._mime }),
      setContent: (text, mime) => { fakeNote._content = text; return Promise.resolve(); }
    };
    enc0.getActiveNote = async () => fakeNote;
    let notified = '';
    enc0.notify = (m) => { notified = m; };
    enc0.notifyError = () => {};
    await enc0.actionWrapEnCryptBlobs();
    check('notified no blobs found', /no raw ENC0 blobs/i.test(notified),
          'got: ' + notified);
    check('content unchanged',
          fakeNote._content === 'just a plain text note with no encrypted content');
  }

  // ---- 6. Too-short base64 (under 84 raw bytes) is skipped ----
  console.log('\n=== too-short b64 is skipped ===');
  {
    // Just the prefix "RU5DMA==" + a few extra chars — well under
    // the 84-byte minimum blob size.
    const fakeNote = {
      _content: 'before RU5DMA==YWJjZA== after',  // 16 raw bytes total
      getContent: () => Promise.resolve({ content: fakeNote._content, mime: fakeNote._mime }),
      setContent: (text, mime) => { fakeNote._content = text; return Promise.resolve(); }
    };
    enc0.getActiveNote = async () => fakeNote;
    enc0.notify = () => {};
    enc0.notifyError = () => {};
    await enc0.actionWrapEnCryptBlobs();
    check('short b64 not wrapped', !/en-crypt/.test(fakeNote._content));
  }

  // ---- 7. Blob inside HTML <p> gets wrapped (test that the regex
  // works across HTML structure) ----
  console.log('\n=== blob inside HTML <p> ===');
  {
    const fakeNote = {
      _content: '<p>some text</p><p>' + realB64 + '</p>',
      getContent: () => Promise.resolve({ content: fakeNote._content, mime: fakeNote._mime }),
      setContent: (text, mime) => { fakeNote._content = text; return Promise.resolve(); }
    };
    enc0.getActiveNote = async () => fakeNote;
    enc0.notify = () => {};
    enc0.notifyError = () => {};
    await enc0.actionWrapEnCryptBlobs();
    check('blob inside <p> is wrapped',
          /<p><en-crypt cipher="AES" hint="" length="128">RU5DM/.test(fakeNote._content));
  }

  // ---- 8. Mixed: one wrapped, one raw, both should be in result ----
  console.log('\n=== mixed: one already-wrapped, one raw ===');
  {
    const realBlob2 = await enc0.encrypt('raw one', 'pw');
    const realB64_2 = Buffer.from(realBlob2).toString('base64');
    const alreadyWrapped = '<en-crypt cipher="AES" hint="" length="128">' + realB64 + '</en-crypt>';
    const fakeNote = {
      _content: 'first: ' + alreadyWrapped + ' second: ' + realB64_2,
      getContent: () => Promise.resolve({ content: fakeNote._content, mime: fakeNote._mime }),
      setContent: (text, mime) => { fakeNote._content = text; return Promise.resolve(); }
    };
    enc0.getActiveNote = async () => fakeNote;
    enc0.notify = () => {};
    enc0.notifyError = () => {};
    await enc0.actionWrapEnCryptBlobs();
    const wraps = (fakeNote._content.match(/<en-crypt cipher="AES" hint="" length="128">/g) || []).length;
    check('exactly two wraps', wraps === 2, 'got ' + wraps);
  }

  // ---- 9. Wrap-then-decrypt round-trip: the wrapped blob is
  // actually decryptable with the right password ----
  console.log('\n=== wrap-then-decrypt round-trip ===');
  {
    const password = 'round-trip-pw-' + Date.now();
    const original = 'this is a secret that should survive wrap+decrypt';
    const blob = await enc0.encrypt(original, password);
    const realB64 = Buffer.from(blob).toString('base64');
    const fakeNote = {
      _content: 'note: ' + realB64 + ' end',
      getContent: () => Promise.resolve({ content: fakeNote._content, mime: fakeNote._mime }),
      setContent: (text, mime) => { fakeNote._content = text; return Promise.resolve(); }
    };
    enc0.getActiveNote = async () => fakeNote;
    enc0.notify = () => {};
    enc0.notifyError = () => {};
    await enc0.actionWrapEnCryptBlobs();
    check('blob is now wrapped',
          /<en-crypt cipher="AES" hint="" length="128">RU5DM/.test(fakeNote._content));
    // Manually parse and decrypt the wrapped blob to confirm it
    // round-trips through the actual crypto.
    const tagRe = /<en-crypt\b[^>]*>([\s\S]*?)<\/en-crypt>/;
    const tagMatch = tagRe.exec(fakeNote._content);
    check('one en-crypt tag exists', !!tagMatch);
    if (tagMatch) {
      const innerB64 = tagMatch[1];
      const innerBlob = Buffer.from(innerB64, 'base64');
      try {
        const pt = await enc0.decrypt(innerBlob, password);
        check('decrypted back to original', enc0.utf8Decode(pt) === original);
      } catch (e) {
        check('decrypted back to original', false, 'err: ' + e.message);
      }
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('Test runner crashed:', e); process.exit(2); });
