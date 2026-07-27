# Trilium ENC0 — Evernote-compatible password encryption for Trilium notes

Pure-JS Trilium note script that lets you encrypt any portion of any Trilium note using the same `<en-crypt>` format Evernote desktop / ENEX uses. Encrypted sections round-trip with Evernote: encrypt in Trilium, export to ENEX, import into Evernote, decrypt there with the same password.

No build step. No dependencies. Runs in your browser, inside Trilium.

## What you get

- **Four toolbar buttons** in Trilium: 🔒 Encrypt selection, 🔓 Decrypt ENC0 blocks, 🏷️ Wrap raw ENC0 blobs, 🔒 Forget ENC0 cache
- **Three hotkeys**: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> / <kbd>D</kbd> / <kbd>F</kbd> (the "wrap" button is toolbar-only — no hotkey, because it's a less-frequent operation)
- **Compatible** with Evernote's `<en-crypt>` ENC0 format — same magic, same PBKDF2 / AES-128-CBC / HMAC-SHA256, same parameter choices (50,000 iterations, 16-byte AES key, 16-byte HMAC key, 16-byte IV, 16-byte salts).
- **Interoperable** with ENEX: encrypted blocks survive the ENEX round-trip and decrypt correctly in Evernote desktop. The HMAC key length matches Evernote exactly — blobs you encrypt in Trilium can be decrypted in Evernote desktop and vice versa (verified: the beernutz/.-MDS-. DC++ hub note from Evernote decrypts cleanly).
- **Browser-only** — uses Web Crypto API. No servers, no keys transmitted anywhere.

## Install (~30 seconds)

1. In Trilium, create a new note.
2. Set its type to **code** (set the language to "JavaScript - Trilium Frontend").
3. Paste the entire contents of [`trilium_enc0.js`](./trilium_enc0.js) into the note body.
4. Add the label `#run=frontendStartup` to the note (the leading `#` is intentional — that's the `~` icon in Trilium's label picker, which means "promoted to attribute"). The label name you want is exactly `#run=frontendStartup`.
5. Save the note. Reload the Trilium frontend (Ctrl+R, or close and reopen). The script registers itself and stays installed across reloads.

To verify: open the browser dev tools console and look for `[trilium-enc0] registered 4 UI hooks total`, `[enc0:hotkey] hotkeys: CTRL+SHIFT+E, CTRL+SHIFT+D, CTRL+SHIFT+F`, and `[trilium-enc0] module installed`.

## Use

### Encrypt

1. Open any Trilium note.
2. Select some text in the body. Multi-line selections work — newlines are preserved across encrypt / decrypt.
3. Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>, or click 🔒 in the toolbar.
4. Type a password. Optionally type a visible hint (it shows up in plaintext next to the encrypted blob, useful as a memory aid).
5. The selection is replaced with a single `<en-crypt cipher="AES" hint="..." length="128">BASE64</en-crypt>` element.

### Decrypt

1. Open a note that contains `<en-crypt>` blocks.
2. Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>, or click 🔓 in the toolbar.
3. Type the password. Every `<en-crypt>` block in the active note is replaced with its plaintext in one pass.
4. If you type the wrong password, the blocks stay encrypted — no data is destroyed.

### Forget the password cache

- <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>, or 🔒 in the toolbar.
- The cache is in-memory only and is wiped automatically when you reload Trilium. Forgetting manually is useful if you're stepping away from the keyboard.

### Wrap raw ENC0 blobs (toolbar button only — no hotkey)

Useful when you paste a raw Evernote `<en-crypt>` blob into a note (e.g. from an ENEX export or copy-paste from a screenshot) without its `<en-crypt>` wrapper, and then want the "Decrypt" action to find it.

The action scans the active note for any base64 string that:
- starts with the b64 of `"ENC0"` (i.e. `RU5DM` + a char in `A`–`P`)
- is at least 112 base64 chars long (= 84 raw bytes — the minimum valid ENC0 blob: 4 magic + 16 salt + 16 salthmac + 16 iv + 32 hmac)
- isn't already inside an existing `<en-crypt>...</en-crypt>` tag

…and wraps each one in `<en-crypt cipher="AES" hint="" length="128">…</en-crypt>`. Multiple blobs per note are handled in one pass.

The HMAC is NOT verified (we don't have a password yet); a blob that was tampered with will simply fail to decrypt when you later run "Decrypt ENC0 blocks".

**Implementation note:** CKEditor 5's `setData()` silently strips unknown elements like `<en-crypt>`, so the wrap action updates the editor via the **CKEditor model API** instead — it finds the text node containing the b64, splits it at the right offsets, and inserts the wrap markers as text. CKEditor then HTML-escapes the angle brackets to `&lt;` and `&gt;` on serialization, which is exactly the form the Decrypt walker already expects. The note's stored content (in the DB) keeps the literal `<en-crypt>…</en-crypt>` tags, so the note remains Evernote-compatible.

### Password cache

For convenience, when you type a password for an `<en-crypt>` block, the script caches it (keyed by the block's hint). When you later run "Decrypt all blocks", blocks that share a hint with a cached password are decrypted without re-prompting.

This cache:
- lives only in the current page (gone on reload)
- is keyed by hint — same hint in two different notes decrypts with the same password
- is wiped on `Forget ENC0 cache` and on a wrong-password attempt for the same hint
- is **not** written to disk or the Trilium DB

If you want a one-time decrypt with no caching, change the hint to a fresh value before decrypting, or just press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> after.

## Remap the hotkeys

Open the script in a Trilium code note and find the `HOTKEYS` constant (a few dozen lines from the top). The default is:

```js
const HOTKEYS = {
  'CTRL+SHIFT+E': 'actionEncryptSelection',
  'CTRL+SHIFT+D': 'actionDecryptAllInNote',
  'CTRL+SHIFT+F': 'actionForgetCachedPasswords'
};
```

Change the keys (e.g. `'CTRL+ALT+E'`) or set any entry to `null` to disable it. The action names on the right must match a function exposed on `globalThis.__trilium_enc0__`.

Reload Trilium for changes to take effect.

## Tests

The repo ships 138 unit tests across six files, plus two Playwright tests that exercise a real CKEditor 5 instance. The unit tests use a minimal in-memory mock of the CKEditor 5 model — no real Trilium or browser needed.

Run all unit tests (Node ≥ 16):

```bash
node _test_trilium.js           # crypto + tag round-trip (21)
node _test_eval_boundary.js     # toolbar / hotkey action-body global access (19)
node _test_modal.js             # custom password prompt modal (3)
node _test_async_helpers.js     # Trilium-API wrappers (28)
node _test_out_of_order.js      # the out-of-order / wrong-block decrypt bug (51)
node _test_wrap_blobs.js        # wrap action (16)
```

Each test file prints `N passed, 0 failed` and exits 0 on success.

The `_test_out_of_order.js` file is the one that pinned down the out-of-order / wrong-block decryption bug — it builds three `<en-crypt>` blocks, decrypts the middle one with a wrong password, and asserts that blocks 1 and 3 still decrypt correctly into the right positions.

The `_test_wrap_blobs.js` file is the unit test for the wrap action.

### Browser tests (Playwright + real CKEditor 5)

Two additional tests exercise a **real** CKEditor 5 instance via Playwright. They were what caught the wrap-action bug (CKEditor 5's `setData()` silently strips unknown elements like `<en-crypt>`, so the wrap action had to switch to the model API).

```bash
npm install playwright
npx playwright install chromium
node _test_ckeditor_sanitize.js  # empirically confirms setData strips <en-crypt>
node _test_wrap_ckeditor.js      # full end-to-end: wrap action puts tags in the model
```

These use the CKEditor 5 build under `../evernote-backup/ckeditor_test/node_modules/@ckeditor/ckeditor5-build-classic/` — they assume that sibling repo is checked out. Adjust the `CK_PATH` at the top of each test file if yours is elsewhere.

## Format reference

The encrypted body is exactly Evernote's ENC0 format:

| offset | size   | field        |
|-------:|-------:|--------------|
| 0      | 4      | magic `"ENC0"` |
| 4      | 16     | salt         (PBKDF2 salt for AES key) |
| 20     | 16     | salthmac     (PBKDF2 salt for HMAC key) |
| 36     | 16     | iv           (AES-CBC IV) |
| 52     | N      | AES-128-CBC ciphertext (PKCS7-padded plaintext; padding handled by Web Crypto) |
| 52+N   | 32     | bodyhmac     (HMAC-SHA256 of everything before this) |

Key derivation (both keys are 16 bytes — the stored HMAC field is 32 bytes because that's HMAC-SHA256's output size, not the key size):

```
aes  = PBKDF2-HMAC-SHA256(pass, salt,     50000, 16)
hmac = PBKDF2-HMAC-SHA256(pass, salthmac, 50000, 16)
```

HMAC coverage is over the entire body (magic + salt + salthmac + iv + ciphertext), which matches the Evernote spec. Verifying the HMAC before attempting decryption means a wrong password or tampered ciphertext throws — it never silently returns garbage.

All crypto uses Web Crypto API (`crypto.subtle`) — no third-party libraries.

## Files

| File | What |
|---|---|
| `trilium_enc0.js` | the script — paste this into a Trilium `#run=frontendStartup` note |
| `_test_trilium.js` | crypto + tag round-trip tests (21) |
| `_test_eval_boundary.js` | tests that the toolbar / hotkey action bodies can see the global helpers (19) |
| `_test_modal.js` | tests the custom password prompt modal (3) |
| `_test_async_helpers.js` | tests the Trilium-API wrappers (note text, editor, etc.) (28) |
| `_test_out_of_order.js` | tests the bug that was the whole reason this script exists: out-of-order decryption with mixed passwords (51) |
| `_test_wrap_blobs.js` | tests the "wrap raw ENC0 blobs" action: finding orphan base64 and wrapping in `<en-crypt>` (16) |
| `_test_ckeditor_sanitize.js` | Playwright test against real CKEditor 5: empirically confirms `setData()` strips `<en-crypt>` |
| `_test_wrap_ckeditor.js` | Playwright test: end-to-end wrap action against real CKEditor 5 (uses the model API, verifies the editor + DB both end up with the wrapped version) |

## Security notes

- **No password recovery.** Forget the password, lose the data. That's the point.
- **The password is never stored** — neither in the note, the cache, nor anywhere else. The cache is in-memory only and is wiped on reload.
- **PBKDF2 with 50 000 iterations** matches Evernote's choice. If you want to push that higher, edit the iteration count in the `deriveBits` calls — but note that anything you encrypt won't decrypt in Evernote desktop anymore.
- **HMAC key is 16 bytes** (PBKDF2 output), **HMAC field is 32 bytes** (HMAC-SHA256's natural output size). This matches Evernote exactly — a 16-byte key gives the right HMAC for their 32-byte stored field. Earlier versions of this script used a 32-byte key, which produced correct round-trips between encrypt + decrypt within the same script but failed against Evernote-produced blobs. The 16-byte key is the spec.
- **HMAC-SHA256 verify-then-decrypt** is enforced. A wrong password or tampered ciphertext throws — it never silently returns garbage.
- **Web Crypto API only** — no JS implementations, no third-party crypto. The browser is doing AES in native code.

## License

MIT, do what you want.
