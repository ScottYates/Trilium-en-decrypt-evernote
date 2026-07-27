// Playwright browser test: simulate Trilium + CKEditor flow and verify
// actionWrapEnCryptBlobs actually wraps the blob (doesn't remove it).
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = 0;  // OS-assigned

// HTTP server that serves both the test page and the script
const server = http.createServer((req, res) => {
  let url = req.url;
  let filePath;
  if (url === '/trilium_enc0.js') {
    filePath = path.join(__dirname, 'trilium_enc0.js');
  } else {
    url = url === '/' ? '/index.html' : url;
    filePath = path.join(__dirname, url);
  }
  const ext = path.extname(filePath);
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[ext] || 'text/plain';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found: ' + filePath); return; }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, () => {
  const port = server.address().port;
  run(port);
});

async function run(port) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('console', msg => console.log('[browser ' + msg.type() + '] ' + msg.text()));
  page.on('pageerror', err => console.log('[pageerror] ' + err.message));

  // First: create a real ENC0 blob by loading the script with a
  // minimal api shim and running encrypt('hello world', 'pw').
  // Then build a test page that:
  //   - creates a note mock with the blob in its text
  //   - mocks getActiveContextTextEditor to return a CKEditor-like
  //     instance with getData/setData that we can inspect
  //   - calls actionWrapEnCryptBlobs
  //   - checks the editor's data afterwards

  // Step 1: get a real b64 blob
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Step 1: encrypt</title></head>
<body><div id="status">booting</div>
<script>
window.__setup = {};
window.__api = {
  addButtonToToolbar: async () => {},
  triggerCommand: async () => {},
  triggerEvent: async () => {},
  getActiveContextNote: async () => null,
  getActiveContextTextEditor: async () => null,
};
</script>
<script src="/trilium_enc0.js"></script>
<script>
(async () => {
  const blob = await globalThis.__trilium_enc0__.encrypt('hello world test', 'pw');
  const b64 = btoa(String.fromCharCode(...new Uint8Array(blob)));
  document.getElementById('status').textContent = b64;
})();
</script>
</body></html>`;
  fs.writeFileSync(path.join(__dirname, 'index.html'), html);
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => document.getElementById('status').textContent.length > 50, { timeout: 5000 });
  const b64 = await page.evaluate(() => document.getElementById('status').textContent);
  console.log('Got b64, length:', b64.length, 'starts with:', b64.slice(0, 10));
  server.close();

  // Step 2: build the real test page
  const noteText = '<p>before</p><p>' + b64 + '</p><p>after</p>';
  const testHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Test</title>
<style>body{font-family:sans-serif;padding:20px}#editor{min-height:400px}.ck-editor__editable p{min-height:1em}</style>
</head>
<body>
<div id="editor">${noteText}</div>
<script src="/trilium_enc0.js"></script>
<script>
window.__test = {
  note: null,
  editor: null,
  history: [],
};

// Trilium API mock
window.api = {
  addButtonToToolbar: async () => {},
  triggerCommand: async () => {},
  triggerEvent: async () => {},
  // These return the note/editor directly (not a function). The
  // real Trilium api returns them as Promises (async functions)
  // that resolve to the actual instance.
  getActiveContextNote: () => Promise.resolve(window.__test.note),
  getActiveContextTextEditor: () => Promise.resolve(window.__test.editor),
};

// Build a note mock with a content accessor that simulates the
// "save on close" behavior — whatever is in the editor wins.
window.__test.note = {
  _content: ${JSON.stringify(noteText)},
  getContent: function() { return Promise.resolve({ content: this._content, mime: 'text/html' }); },
  setContent: function(text, mime) {
    window.__test.history.push({ op: 'setContent', old: this._content, new: text });
    this._content = text;
    return Promise.resolve();
  },
};

// CKEditor-like editor wrapper. The KEY thing: it has its own
// internal data state. setData updates that state. The note
// mock's _content is updated independently by setNoteText.
window.__test.editor = {
  _data: ${JSON.stringify(noteText)},
  getData: function() { return this._data; },
  setData: function(text) {
    window.__test.history.push({ op: 'setData', old: this._data, new: text });
    this._data = text;
  },
  _context: {
    editor: {
      model: {
        document: { getRoot: () => null },
        change: (fn) => { /* no-op fallback */ },
      },
    },
  },
};
</script>
</body></html>`;
  fs.writeFileSync(path.join(__dirname, 'index.html'), testHtml);
  // Re-serve the new page
  const server2 = http.createServer((req, res) => {
    let url = req.url;
    let filePath;
    if (url === '/trilium_enc0.js') {
      filePath = path.join(__dirname, 'trilium_enc0.js');
    } else {
      url = url === '/' ? '/index.html' : url;
      filePath = path.join(__dirname, url);
    }
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[ext] || 'text/plain';
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found: ' + filePath); return; }
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
  });
  const port2 = await new Promise((resolve) => {
    server2.listen(0, () => resolve(server2.address().port));
  });
  await page.goto(`http://localhost:${port2}/`);

  // Wait for script to load
  await page.waitForFunction(() => typeof globalThis.__trilium_enc0__ !== 'undefined', { timeout: 5000 });

  // Snapshot the before state
  const before = await page.evaluate(() => ({
    noteContent: window.__test.note._content,
    editorData: window.__test.editor._data,
    historyLen: window.__test.history.length,
  }));
  console.log('\n=== BEFORE ===');
  console.log('note._content:', before.noteContent);
  console.log('editor._data:', before.editorData);
  console.log('history length:', before.historyLen);

  // Run the action
  const result = await page.evaluate(async () => {
    const log = [];
    const origNote = globalThis.__trilium_enc0__.getActiveNote;
    const origSetNote = globalThis.__trilium_enc0__.setNoteText;
    const origGetEd = globalThis.__trilium_enc0__.getActiveTextEditor;
    const origNotify = globalThis.__trilium_enc0__.notify;
    const origNotifyErr = globalThis.__trilium_enc0__.notifyError;
    globalThis.__trilium_enc0__.notify = (m) => log.push('notify: ' + m);
    globalThis.__trilium_enc0__.notifyError = (m) => log.push('notifyErr: ' + m);
    await globalThis.__trilium_enc0__.actionWrapEnCryptBlobs();
    return { log, history: window.__test.history };
  });
  console.log('\n=== ACTION OUTPUT ===');
  for (const l of result.log) console.log('  ' + l);
  console.log('\n=== HISTORY ===');
  for (const h of result.history) {
    if (h.op === 'setContent') {
      console.log('  setContent: ' + (h.old || '').slice(0, 60) + ' -> ' + (h.new || '').slice(0, 60));
    } else if (h.op === 'setData') {
      console.log('  setData: ' + (h.old || '').slice(0, 60) + ' -> ' + (h.new || '').slice(0, 60));
    }
  }

  // Snapshot the after state
  const after = await page.evaluate(() => ({
    noteContent: window.__test.note._content,
    editorData: window.__test.editor._data,
  }));
  console.log('\n=== AFTER ===');
  console.log('note._content:', after.noteContent);
  console.log('editor._data:', after.editorData);

  // Verify: the blob should still be in BOTH the note and the editor,
  // just wrapped in <en-crypt>.
  const b64ForCheck = b64;
  const checks = await page.evaluate((b64) => {
    const note = window.__test.note._content;
    const editor = window.__test.editor._data;
    return {
      noteHasBlob: note.indexOf(b64) !== -1,
      noteWrapped: /<en-crypt cipher="AES" hint="" length="128">/.test(note) && note.indexOf(b64) !== -1,
      editorHasBlob: editor.indexOf(b64) !== -1,
      editorWrapped: /<en-crypt cipher="AES" hint="" length="128">/.test(editor) && editor.indexOf(b64) !== -1,
    };
  }, b64ForCheck);
  console.log('\n=== CHECKS ===');
  for (const k in checks) console.log('  ' + k + ': ' + checks[k]);

  await browser.close();
  server2.close();

  const allOk = Object.values(checks).every(v => v);
  if (!allOk) {
    console.log('\n*** FAIL: blob was removed or not wrapped ***');
    process.exit(1);
  } else {
    console.log('\n*** PASS: blob is wrapped in both note and editor ***');
    process.exit(0);
  }
}
