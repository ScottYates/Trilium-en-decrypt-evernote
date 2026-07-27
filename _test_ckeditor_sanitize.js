// Test: what does real CKEditor 5 do with <en-crypt> in setData?
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
      if (err) { res.writeHead(404); res.end('not found: ' + filePath); return; }
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
  });
  const port = await new Promise(r => server.listen(0, () => r(server.address().port)));

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', msg => console.log('[browser] ' + msg.text()));
  page.on('pageerror', err => console.log('[pageerror] ' + err.message));

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Test</title>
<style>body{font-family:sans-serif;padding:20px}#editor{min-height:300px}.ck-editor__editable p{min-height:1em}</style>
</head>
<body>
<div id="editor">
<p>before</p>
<p>RU5DMKiiE1uPEakX8kz0RTI0llzbwfAn7nddFI+8Rr4v/aXWI0kRE6AK0CgCNDP83VIvmLdbjRQxlX3budJy/AHiemOVZixdG4L+WRPrVXSc7g7iKd8JaPKR0hgnn+5xvLMD1yMa+bntexgIPwlmD5PN7awRjwWiDB0vovv/LcnwUKVgxY82o1wDZXM3OAIaQhm3qjAlGq9cy1k6kCNtVOA0ihttc5mhGmale3uGhhztjuEGA+5SjdW0LpsN9Da8/ao5OJkr7webXXqEQanIoBH/qwCTmTZYjZOaQX7nha/BaBK3zlIsc/YmUjBORb6upwbmNft0uXDPeIR7AEUfGhDFfeIeizFWgisTSKDcqxAZg6E2eij/vSEvueiaal3XYrstdiPf6jq4gi0aOcGKZdu3B8Kj+yyVxb6lJ2ETD8i3JA7Jfa4V8rSVDe2aIIh8gHfWx0/UYGPIDcG8fZpgsAId7EuwUlfev53a+X1AUMg0Agbg70n40sB+cMlqZxI7YjCFFTIHELYlMZ4wvfuJN5Vdfrq0Ui9Me7bDQtUT5Rbx/DwxwN7XQm7SFx7ALW2t9rqjCp9p6NzPJyy/dwrOFaBWd2s=</p>
<p>after</p>
</div>
<script src="/ckeditor.js"></script>
<script>
ClassicEditor.create(document.querySelector('#editor'), { licenseKey: 'GPL' }).then(editor => {
  window.editor = editor;
  window.__ckData = () => editor.getData();
  console.log('Editor ready, initial data length:', editor.getData().length);
  console.log('initial data:', editor.getData().slice(0, 200));
});
</script>
</body></html>`;
  fs.writeFileSync(path.join(__dirname, 'index.html'), html);
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => window.editor !== undefined, { timeout: 10000 });
  await new Promise(r => setTimeout(r, 1000));

  // Get the initial data
  const initial = await page.evaluate(() => window.__ckData());
  console.log('\n=== Initial data ===');
  console.log(initial);
  console.log('contains <en-crypt>:', /<en-crypt/.test(initial));
  console.log('contains the b64 blob:', /RU5DMKiiE1uPEakX/.test(initial));

  // Now try setData with a wrapped version
  const wrapped = '<p>before</p><p><en-crypt cipher="AES" hint="" length="128">RU5DMKiiE1uPEakX8kz0RTI0llzbwfAn7nddFI+8Rr4v/aXWI0kRE6AK0CgCNDP83VIvmLdbjRQxlX3budJy/AHiemOVZixdG4L+WRPrVXSc7g7iKd8JaPKR0hgnn+5xvLMD1yMa+bntexgIPwlmD5PN7awRjwWiDB0vovv/LcnwUKVgxY82o1wDZXM3OAIaQhm3qjAlGq9cy1k6kCNtVOA0ihttc5mhGmale3uGhhztjuEGA+5SjdW0LpsN9Da8/ao5OJkr7webXXqEQanIoBH/qwCTmTZYjZOaQX7nha/BaBK3zlIsc/YmUjBORb6upwbmNft0uXDPeIR7AEUfGhDFfeIeizFWgisTSKDcqxAZg6E2eij/vSEvueiaal3XYrstdiPf6jq4gi0aOcGKZdu3B8Kj+yyVxb6lJ2ETD8i3JA7Jfa4V8rSVDe2aIIh8gHfWx0/UYGPIDcG8fZpgsAId7EuwUlfev53a+X1AUMg0Agbg70n40sB+cMlqZxI7YjCFFTIHELYlMZ4wvfuJN5Vdfrq0Ui9Me7bDQtUT5Rbx/DwxwN7XQm7SFx7ALW2t9rqjCp9p6NzPJyy/dwrOFaBWd2s=</en-crypt></p><p>after</p>';
  await page.evaluate((d) => window.editor.setData(d), wrapped);
  await new Promise(r => setTimeout(r, 500));

  const after = await page.evaluate(() => window.__ckData());
  console.log('\n=== After setData with wrapped ===');
  console.log(after);
  console.log('contains <en-crypt>:', /<en-crypt/.test(after));
  console.log('contains the b64 blob:', /RU5DMKiiE1uPEakX/.test(after));
  console.log('contains escaped form (&lt;en-crypt):', /&lt;en-crypt/.test(after));

  // Try setData with the raw blob (no wrap)
  const raw = '<p>before</p><p>RU5DMKiiE1uPEakX8kz0RTI0llzbwfAn7nddFI+8Rr4v/aXWI0kRE6AK0CgCNDP83VIvmLdbjRQxlX3budJy/AHiemOVZixdG4L+WRPrVXSc7g7iKd8JaPKR0hgnn+5xvLMD1yMa+bntexgIPwlmD5PN7awRjwWiDB0vovv/LcnwUKVgxY82o1wDZXM3OAIaQhm3qjAlGq9cy1k6kCNtVOA0ihttc5mhGmale3uGhhztjuEGA+5SjdW0LpsN9Da8/ao5OJkr7webXXqEQanIoBH/qwCTmTZYjZOaQX7nha/BaBK3zlIsc/YmUjBORb6upwbmNft0uXDPeIR7AEUfGhDFfeIeizFWgisTSKDcqxAZg6E2eij/vSEvueiaal3XYrstdiPf6jq4gi0aOcGKZdu3B8Kj+yyVxb6lJ2ETD8i3JA7Jfa4V8rSVDe2aIIh8gHfWx0/UYGPIDcG8fZpgsAId7EuwUlfev53a+X1AUMg0Agbg70n40sB+cMlqZxI7YjCFFTIHELYlMZ4wvfuJN5Vdfrq0Ui9Me7bDQtUT5Rbx/DwxwN7XQm7SFx7ALW2t9rqjCp9p6NzPJyy/dwrOFaBWd2s=</p><p>after</p>';
  await page.evaluate((d) => window.editor.setData(d), raw);
  await new Promise(r => setTimeout(r, 500));

  const after2 = await page.evaluate(() => window.__ckData());
  console.log('\n=== After setData with raw ===');
  console.log(after2);
  console.log('contains the b64 blob:', /RU5DMKiiE1uPEakX/.test(after2));

  await browser.close();
  server.close();
})();
