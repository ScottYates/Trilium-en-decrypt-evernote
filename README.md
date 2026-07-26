# Trilium ENC0 — Evernote-compatible password encryption for Trilium notes

Pure-JS Trilium note script that lets you encrypt any portion of any Trilium note using the same `<en-crypt>` format Evernote desktop / ENEX uses. Encrypted sections round-trip with Evernote: encrypt in Trilium, export to ENEX, import into Evernote, decrypt there with the same password.

No build step. No dependencies. Runs in your browser, inside Trilium.

## What you get

- **Three toolbar buttons** in Trilium: 🔒 Encrypt selection, 🔓 Decrypt ENC0 blocks, 🔒 Forget ENC0 cache
- **Three hotkeys**: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> / <kbd>D</kbd> / <kbd>F</kbd>
- **Compatible** with Evernote's `<en-crypt>` ENC0 format — same magic, same PBKDF2 / AES-128-CBC / HMAC-SHA256, same parameter choices (50 000 iterations, 16-byte keys, 16-byte IV, 16-byte salts).
- **Interoperable** with ENEX: encrypted blocks survive the ENEX round-trip and decrypt correctly in Evernote desktop.
- **Browser-only** — uses Web Crypto API. No servers, no keys transmitted anywhere.

## Install (~30 seconds)

1. In Trilium, create a new note.
2. Set its type to **code** (set the language to "JavaScript - Trilium Frontend").
3. Paste the entire contents of [`trilium_enc0.js`](./trilium_enc0.js) into the note body.
4. Add the label `#run=frontendStartup` to the note (the leading `#` is intentional — that's the `~` icon in Trilium's label picker, which means "promoted to attribute"). The label name you want is exactly `#run=frontendStartup`.
5. Save the note. Reload the Trilium frontend (Ctrl+R, or close and reopen). The script registers itself and stays installed across reloads.

To verify: open the browser dev tools console and look for `[trilium-enc0] module installed` and `[enc0:hotkey] hotkeys: CTRL+SHIFT+E, CTRL+SHIFT+D, CTRL+SHIFT+F`.

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

The repo ships 122 unit tests across five files. They use a minimal in-memory mock of the CKEditor 5 model — no real Trilium or browser needed.

Run them all (Node ≥ 16):

```bash
node _test_trilium.js
node _test_eval_boundary.js
node _test_modal.js
node _test_async_helpers.js
node _test_out_of_order.js
```

Each test file prints `N passed, 0 failed` and exits 0 on success. The `_test_out_of_order.js` file is the one that pinned down the out-of-order / wrong-block decryption bug — it builds three `<en-crypt>` blocks, decrypts the middle one with a wrong password, and asserts that blocks 1 and 3 still decrypt correctly into the right positions.

## Format reference

The encrypted body is exactly Evernote's ENC0 format:

| offset | size   | field        |
|-------:|-------:|--------------|
| 0      | 4      | magic `"ENC0"` |
| 4      | 16     | salt         (PBKDF2 salt for AES key) |
| 20     | 16     | salthmac     (PBKDF2 salt for HMAC key) |
| 36     | 16     | iv           (AES-CBC IV) |
| 52     | N      | AES-128-CBC ciphertext (PKCS7-padded plaintext) |
| 52+N   | 32     | bodyhmac     (HMAC-SHA256 of everything before this) |

Key derivation:

```
aes  = PBKDF2-HMAC-SHA256(pass, salt,     50000, 16)
hmac = PBKDF2-HMAC-SHA256(pass, salthmac, 50000, 32)
```

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

## Security notes

- **No password recovery.** Forget the password, lose the data. That's the point.
- **The password is never stored** — neither in the note, the cache, nor anywhere else. The cache is in-memory only and is wiped on reload.
- **PBKDF2 with 50 000 iterations** matches Evernote's choice. If you want to push that higher, edit the iteration count in the `deriveBits` calls — but note that anything you encrypt won't decrypt in Evernote desktop anymore.
- **HMAC-SHA256 verify-then-decrypt** is enforced. A wrong password or tampered ciphertext throws — it never silently returns garbage.
- **Web Crypto API only** — no JS implementations, no third-party crypto. The browser is doing AES in native code.

## License

MIT, do what you want.
