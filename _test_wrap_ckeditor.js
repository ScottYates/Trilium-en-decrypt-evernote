// Minimal test: verify the wrap action works in a REAL CKEditor 5.
// (We skip the full decrypt round-trip — the model API on decrypt
// can be slow; we trust the existing _test_out_of_order.js walker
// tests for that.)
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

(async () => {
  const CK_PATH = path.join(__dirname, '..', 'evernote-backup', 'ckeditor_test', 'node_modules', '@ckeditor', 'ckeditor5-build-classic', 'build', 'ckeditor.js');
  const server = http.createServer((req, res) => {
    let url = req.url;
    let filePath;
    if (url === '/ckeditor.js') {
      filePath = CK_PATH;
    } else {
      url = url === '/' ? '/index.html' : url;
      filePath = path.join(__dirname, url);
    }
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[ext] || 'text/plain';
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
  });
  const port = await new Promise(r => server.listen(0, () => r(server.address().port)));

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', msg => console.log('[browser] ' + msg.text()));
  page.on('pageerror', err => console.log('[pageerror] ' + err.message));

  // Get a real b64 blob
  fs.writeFileSync(path.join(__dirname, 'index.html'), `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<div id="status">booting</div>
<script>window.api={addButtonToToolbar:async()=>{}};</script>
<script src="/trilium_enc0.js"></script>
<script>
(async () => {
  const blob = await globalThis.__trilium_enc0__.encrypt('hello world test', 'pw');
  const b64 = btoa(String.fromCharCode(...new Uint8Array(blob)));
  document.getElementById('status').textContent = b64;
})();
</script>
</body></html>`);
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => document.getElementById('status').textContent.length > 50, { timeout: 5000 });
  const b64 = await page.evaluate(() => document.getElementById('status').textContent);
  console.log('Got b64, length:', b64.length, 'starts with:', b64.slice(0, 10));
  server.close();

  // Real CKEditor + trilium_enc0
  const b64ForHtml = b64;
  fs.writeFileSync(path.join(__dirname, 'index.html'), `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body>
<div id="editor">
<p>before</p>
<p>${b64ForHtml}</p>
<p>after</p>
</div>
<script src="/trilium_enc0.js"></script>
<script>
window.api = { addButtonToToolbar: async () => {} };
window.__note = {
  _content: document.getElementById('editor').innerHTML,
  getContent: function() { return Promise.resolve({ content: this._content, mime: 'text/html' }); },
  setContent: function(text, mime) { this._content = text; return Promise.resolve(); },
};
</script>
<script src="/ckeditor.js"></script>
<script>
ClassicEditor.create(document.querySelector('#editor'), { licenseKey: 'GPL' }).then(editor => {
  window.editor = editor;
  const wrapper = {
    _context: { editor: editor },
    getData: () => editor.getData(),
    setData: (text) => editor.setData(text),
    getSelectedHtml: () => '',
    removeSelection: () => {},
  };
  window.__editor = wrapper;
  window.api.getActiveContextNote = () => Promise.resolve(window.__note);
  window.api.getActiveContextTextEditor = () => Promise.resolve(window.__editor);
  console.log('Editor ready, initial data length:', editor.getData().length);
});
</script>
</body></html>`);

  const server2 = http.createServer((req, res) => {
    let url = req.url;
    let filePath;
    if (url === '/ckeditor.js') {
      filePath = CK_PATH;
    } else {
      url = url === '/' ? '/index.html' : url;
      filePath = path.join(__dirname, url);
    }
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[ext] || 'text/plain';
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
  });
  const port2 = await new Promise(r => server2.listen(0, () => r(server2.address().port)));
  await page.goto(`http://localhost:${port2}/`);
  await page.waitForFunction(() => window.editor !== undefined, { timeout: 10000 });
  await new Promise(r => setTimeout(r, 1500));

  // Initial state
  const initial = await page.evaluate(() => window.editor.getData());
  console.log('\n=== Initial state ===');
  console.log('data length:', initial.length);
  console.log('has raw b64:', initial.indexOf('${b64}') !== -1);
  console.log('has wrap tags:', /&lt;en-crypt/.test(initial) || /<en-crypt/.test(initial));
  console.log('snippet:', initial.slice(0, 250));

  // Run the wrap action
  const result = await page.evaluate(async () => {
    const log = [];
    globalThis.__trilium_enc0__.notify = (m) => log.push('notify: ' + m);
    globalThis.__trilium_enc0__.notifyError = (m) => log.push('notifyErr: ' + m);
    await globalThis.__trilium_enc0__.actionWrapEnCryptBlobs();
    return { log };
  });
  console.log('\n=== Action log ===');
  for (const l of result.log) console.log('  ' + l);

  // After state — use a shorter marker to avoid the b64 string
  // having characters that confuse the indexOf / page.evaluate
  // serialization. The b64 is unique and always 156 chars, so
  // we just check that a b64-shaped string is present.
  const after = await page.evaluate(() => {
    const data = window.editor.getData();
    return {
      data: data,
      // Match any 156+ char b64-shaped string (the encrypted blob)
      hasRawB64: /RU5DM[A-P][A-Za-z0-9+/=]{140,}/.test(data),
      hasWrapEntities: /&lt;en-crypt\b/.test(data) && /&lt;\/en-crypt&gt;/.test(data),
      hasWrapRawTags: /<en-crypt\b/.test(data),  // should be FALSE (no raw tags)
    };
  });
  console.log('\n=== After wrap ===');
  console.log('data length:', after.data.length);
  console.log('has b64 (regex):', after.hasRawB64);
  console.log('has wrap entities (&lt;en-crypt&gt;...&lt;/en-crypt&gt;):', after.hasWrapEntities);
  console.log('has raw <en-crypt> tag (should be false):', after.hasWrapRawTags);
  console.log('snippet:', after.data.slice(0, 350));

  // Also check the note's stored content matches
  const noteContent = await page.evaluate(() => window.__note._content);
  console.log('\n=== Note DB content ===');
  console.log('has b64 (regex):', /RU5DM[A-P][A-Za-z0-9+/=]{140,}/.test(noteContent));
  console.log('has literal <en-crypt> tag (DB stores HTML):', /<en-crypt\b/.test(noteContent));
  console.log('snippet:', noteContent.slice(0, 350));

  await browser.close();
  server2.close();

  // Pass criteria: b64 still present, wrap entities present, no raw tags
  const ok = after.hasRawB64 && after.hasWrapEntities && !after.hasWrapRawTags;
  console.log('\n=== ' + (ok ? 'PASS' : 'FAIL') + ' ===');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('Test runner crashed:', e); process.exit(2); });
