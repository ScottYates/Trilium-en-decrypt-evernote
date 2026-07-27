// Test the model-walker's "don't double-wrap" behaviour against a real
// CKEditor 5. Specifically: the regex `&lt;en-crypt ... &gt;...b64...&lt;/en-crypt&gt;`
// should NOT wrap the b64 a second time. This was the bug — the
// old per-text-node check `if (/&lt;en-crypt\b/.test(data) && /&lt;\/en-crypt&gt;/.test(data))`
// would incorrectly skip a whole text node that had BOTH a wrap and an
// unwrapped b64 in it. The fix uses per-match depth tracking.
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

  // Get TWO real b64 blobs
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('console', msg => console.log('[browser] ' + msg.text()));
  page.on('pageerror', err => console.log('[pageerror] ' + err.message));

  fs.writeFileSync(path.join(__dirname, 'index.html'), `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<div id="status">booting</div>
<script>window.api={addButtonToToolbar:async()=>{}};</script>
<script src="/trilium_enc0.js"></script>
<script>
(async () => {
  const blob1 = await globalThis.__trilium_enc0__.encrypt('blob one', 'pw');
  const blob2 = await globalThis.__trilium_enc0__.encrypt('blob two', 'pw');
  const b64_1 = btoa(String.fromCharCode(...new Uint8Array(blob1)));
  const b64_2 = btoa(String.fromCharCode(...new Uint8Array(blob2)));
  document.getElementById('status').textContent = JSON.stringify({ b64_1, b64_2 });
})();
</script>
</body></html>`);
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => document.getElementById('status').textContent.length > 50, { timeout: 5000 });
  const b64s = await page.evaluate(() => JSON.parse(document.getElementById('status').textContent));
  console.log('Got b64s:', b64s.b64_1.slice(0,10), '...', b64s.b64_2.slice(0,10), '...');
  server.close();

  // Helper: run the test with a given initial HTML, get the post-action data
  async function runTest(page, label, initialData) {
    console.log('\n=== ' + label + ' ===');
    fs.writeFileSync(path.join(__dirname, 'index.html'), `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body>
<div id="editor">${initialData}</div>
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

    // Run the action
    await page.evaluate(async () => {
      await globalThis.__trilium_enc0__.actionWrapEnCryptBlobs();
    });
    await new Promise(r => setTimeout(r, 500));

    const data = await page.evaluate(() => window.editor.getData());
    server2.close();
    return data;
  }

  // ---- Test 1: a single already-wrapped blob, no other b64 ----
  const wrap1 = '<en-crypt cipher="AES" hint="" length="128">' + b64s.b64_1 + '</en-crypt>';
  const d1 = await runTest(page, 'already-wrapped, no other blob',
    '<p>before</p><p>' + wrap1 + '</p><p>after</p>');
  console.log('  data:', d1.slice(0, 250) + '...');
  const open1 = (d1.match(/&lt;en-crypt\b/g) || []).length;
  const close1 = (d1.match(/&lt;\/en-crypt&gt;/g) || []).length;
  console.log('  opens:', open1, 'closes:', close1, '(should be 1 and 1)');
  const t1pass = open1 === 1 && close1 === 1 && d1.indexOf(b64s.b64_1) !== -1;

  // ---- Test 2: a wrapped blob PLUS a raw b64 in the same text node ----
  const d2 = await runTest(page, 'wrapped blob + raw blob in same text node',
    '<p>' + wrap1 + ' and ' + b64s.b64_2 + '</p>');
  console.log('  data:', d2.slice(0, 300) + '...');
  const open2 = (d2.match(/&lt;en-crypt\b/g) || []).length;
  const close2 = (d2.match(/&lt;\/en-crypt&gt;/g) || []).length;
  console.log('  opens:', open2, 'closes:', close2, '(should be 2 and 2)');
  const t2pass = open2 === 2 && close2 === 2;

  // ---- Test 3: b64 inside existing wrap, plus an outer b64 in next <p> ----
  const d3 = await runTest(page, 'wrap with b64 inside existing wrap, plus outer b64',
    '<p>' + wrap1 + '</p><p>middle ' + b64s.b64_2 + '</p>');
  console.log('  data:', d3.slice(0, 350) + '...');
  const open3 = (d3.match(/&lt;en-crypt\b/g) || []).length;
  const close3 = (d3.match(/&lt;\/en-crypt&gt;/g) || []).length;
  console.log('  opens:', open3, 'closes:', close3, '(should be 2 and 2)');
  const t3pass = open3 === 2 && close3 === 2;

  await browser.close();

  // ---- Summary ----
  console.log('\n=== SUMMARY ===');
  console.log('Test 1 (already-wrapped): ' + (t1pass ? 'PASS' : 'FAIL'));
  console.log('Test 2 (wrapped + raw in same node): ' + (t2pass ? 'PASS' : 'FAIL'));
  console.log('Test 3 (nested-style): ' + (t3pass ? 'PASS' : 'FAIL'));
  const allPass = t1pass && t2pass && t3pass;
  process.exit(allPass ? 0 : 1);
})().catch(e => { console.error('Test runner crashed:', e); process.exit(2); });
