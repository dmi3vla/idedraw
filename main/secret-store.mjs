// API key storage (plan stream C2 — this is the A1 surface). The key is
// encrypted with Electron's safeStorage (OS keyring: libsecret/kwallet) and
// stored as a binary blob in userData. It NEVER goes into chat-config.json
// and is never sent back to the renderer — the renderer only ever gets a
// boolean "key exists" status, so the key cannot leak through the UI.

import { safeStorage } from 'electron';
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export function createSecretStore(userDataDir) {
  const file = path.join(userDataDir, 'chat-key.bin');

  function isAvailable() {
    return safeStorage.isEncryptionAvailable();
  }

  function setKey(plain) {
    if (typeof plain !== 'string' || plain.length === 0) {
      throw Object.assign(new Error('API key must be a non-empty string'), { code: 'BAD_INPUT' });
    }
    if (!isAvailable()) {
      throw Object.assign(
        new Error('safeStorage is not available on this system (no OS keyring?) — key cannot be stored securely'),
        { code: 'NO_KEYRING' }
      );
    }
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(file, safeStorage.encryptString(plain));
  }

  // Main-process use only (e.g. connection test). Returns null if absent.
  function getKey() {
    try {
      return safeStorage.decryptString(readFileSync(file));
    } catch {
      return null;
    }
  }

  function hasKey() {
    return getKey() !== null;
  }

  function clearKey() {
    try {
      unlinkSync(file);
    } catch {
      // already absent — clearing a missing key is fine
    }
  }

  return { isAvailable, setKey, getKey, hasKey, clearKey, file };
}
