/* ---------------------------------------------------------------------------
 * Website token vault — the publishing token, carried by the website itself.
 *
 * The administrator used to have to paste the GitHub Personal Access Token on
 * every computer, because GitHub's Actions secret store is write-only and a
 * browser copy never leaves the device it was saved on. This module stores the
 * token *in the repository* instead — `assets/data/publish-token.json`, which
 * GitHub Pages then serves as part of the website — so signing in on any
 * laptop reconnects publishing automatically.
 *
 * That file is public, so the token is never written to it in the clear:
 *
 *   1. A random 256-bit data key encrypts the token (AES-256-GCM).
 *   2. That data key is wrapped once per "slot" — one for the administrator
 *      sign-in password, one for the master password — with a key derived from
 *      the password through PBKDF2-HMAC-SHA-256 and a per-slot random salt.
 *   3. Only the ciphertext, the salts and the IVs are committed.
 *
 * Opening the vault therefore needs a password that is never stored anywhere:
 * the administrator types it to sign in, or to unlock Cloud Settings, and the
 * website decrypts the token in memory. Anyone else downloading the file gets
 * unusable ciphertext.
 *
 * Because the file is public, the protection is only ever as strong as the
 * passwords: use long, unique administrator and master passwords, scope the
 * token to this one repository, and revoke it on GitHub if a password leaks.
 *
 * Everything here is pure Web Crypto with no DOM access, so it runs unchanged
 * in the browser and in the test suite.
 * ------------------------------------------------------------------------- */

/** Repository path of the encrypted vault, served by GitHub Pages. */
export const TOKEN_VAULT_PATH = 'assets/data/publish-token.json';
export const TOKEN_VAULT_VERSION = 1;
/** Password slots that can unwrap the data key, in preference order. */
export const TOKEN_VAULT_SLOTS = Object.freeze(['admin', 'master']);
export const TOKEN_VAULT_SLOT_LABELS = Object.freeze({
  admin: 'administrator sign-in password',
  master: 'master password'
});
/** PBKDF2 work factor. Stored per vault so it can be raised later. */
export const TOKEN_VAULT_ITERATIONS = 310_000;
const MIN_ITERATIONS = 50_000;
const MAX_ITERATIONS = 4_000_000;

const KDF_NAME = 'PBKDF2';
const KDF_HASH = 'SHA-256';
const CIPHER = 'AES-GCM';
const KEY_BITS = 256;
const IV_BYTES = 12;
const SALT_BYTES = 16;
const DATA_KEY_BYTES = 32;
const AAD_PREFIX = 'schoolcloud.token.vault.v1';

export const TOKEN_VAULT_COMMENT = Object.freeze([
  'Encrypted GitHub publishing token for the School Cloud administrator.',
  'This file is public. It holds ciphertext only — never a usable token.',
  'The token is sealed with AES-256-GCM; the data key is wrapped separately',
  'for the administrator sign-in password and for the master password using',
  'PBKDF2-HMAC-SHA-256 with a random per-slot salt.',
  'Signing in on any computer unlocks it in the browser, so the administrator',
  'never has to paste the token again. Rotating a password re-locks this file.',
  'Delete the slots (or press "Remove from this website" in Cloud Settings) to',
  'stop sharing the token, and revoke the token on GitHub if a password leaks.'
]);

function subtleCrypto() {
  const api = globalThis.crypto?.subtle;
  if (!api) {
    throw new Error('This browser cannot encrypt the token (Web Crypto is unavailable). Open the site over HTTPS and try again.');
  }
  return api;
}

function randomBytes(length) {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('This browser cannot generate secure random values, so the token was not stored.');
  }
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function encodeBase64(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let binary = '';
  for (let index = 0; index < data.length; index += 1) binary += String.fromCharCode(data[index]);
  return btoa(binary);
}

export function decodeBase64(value) {
  const normalized = String(value || '').replace(/\s/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function additionalData(label) {
  return new TextEncoder().encode(`${AAD_PREFIX}:${label}`);
}

function safeIterations(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return TOKEN_VAULT_ITERATIONS;
  return Math.min(MAX_ITERATIONS, Math.max(MIN_ITERATIONS, Math.round(number)));
}

function isSealed(part) {
  return Boolean(part && typeof part === 'object' && typeof part.iv === 'string' && part.iv && typeof part.data === 'string' && part.data);
}

/** Derive the AES key that wraps the data key for one password slot. */
async function deriveSlotKey(password, salt, iterations) {
  const subtle = subtleCrypto();
  const material = await subtle.importKey(
    'raw', new TextEncoder().encode(String(password ?? '')), KDF_NAME, false, ['deriveKey']
  );
  return subtle.deriveKey(
    { name: KDF_NAME, salt, iterations: safeIterations(iterations), hash: KDF_HASH },
    material,
    { name: CIPHER, length: KEY_BITS },
    false,
    ['encrypt', 'decrypt']
  );
}

async function importDataKey(raw) {
  return subtleCrypto().importKey('raw', raw, { name: CIPHER, length: KEY_BITS }, false, ['encrypt', 'decrypt']);
}

async function seal(key, bytes, label) {
  const iv = randomBytes(IV_BYTES);
  const sealed = await subtleCrypto().encrypt(
    { name: CIPHER, iv, additionalData: additionalData(label) }, key, bytes
  );
  return { iv: encodeBase64(iv), data: encodeBase64(new Uint8Array(sealed)) };
}

async function unseal(key, part, label) {
  const opened = await subtleCrypto().decrypt(
    { name: CIPHER, iv: decodeBase64(part.iv), additionalData: additionalData(label) },
    key,
    decodeBase64(part.data)
  );
  return new Uint8Array(opened);
}

/** True when `value` looks like a vault this build can read. */
export function isTokenVault(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Number(value.version) !== TOKEN_VAULT_VERSION) return false;
  if (!isSealed(value.token)) return false;
  const slots = value.slots;
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return false;
  return TOKEN_VAULT_SLOTS.some(slot => isSealed(slots[slot]) && typeof slots[slot].salt === 'string' && slots[slot].salt);
}

/** Password slots that can open this vault. */
export function tokenVaultSlots(vault) {
  if (!isTokenVault(vault)) return [];
  return TOKEN_VAULT_SLOTS.filter(slot => isSealed(vault.slots[slot]) && Boolean(vault.slots[slot].salt));
}

/** Everything about a vault that is safe to show in the interface. */
export function describeTokenVault(vault) {
  const slots = tokenVaultSlots(vault);
  return {
    present: slots.length > 0,
    slots,
    updatedAt: typeof vault?.updatedAt === 'string' ? vault.updatedAt : '',
    repository: typeof vault?.repository === 'string' ? vault.repository : '',
    iterations: safeIterations(vault?.kdf?.iterations)
  };
}

/**
 * True when the vault slot was locked with a password generation that the
 * deployed config.js has since replaced. Used to tell the administrator the
 * website copy needs saving again after a password rotation.
 */
export function tokenVaultSlotIsStale(vault, slot, currentGateSalt) {
  const entry = vault?.slots?.[slot];
  const recorded = typeof entry?.gate === 'string' ? entry.gate : '';
  const current = String(currentGateSalt || '');
  if (!recorded || !current) return false;
  return recorded !== current;
}

/** An empty vault: the file stays in place, but it carries no token. */
export function emptyTokenVault({ repository = '' } = {}) {
  return {
    _comment: [...TOKEN_VAULT_COMMENT],
    version: TOKEN_VAULT_VERSION,
    updatedAt: new Date().toISOString(),
    repository: String(repository || ''),
    cipher: CIPHER,
    kdf: { name: KDF_NAME, hash: KDF_HASH, iterations: TOKEN_VAULT_ITERATIONS },
    token: null,
    slots: {}
  };
}

/**
 * Build the encrypted record that is committed to the repository.
 *
 * `passwords` maps slot names to the plain passwords the administrator has
 * just typed; empty slots are skipped. The passwords themselves are used only
 * to derive a key here — they are never part of the returned object.
 */
export async function createTokenVault({
  token, passwords = {}, repository = '', gates = {}, iterations = TOKEN_VAULT_ITERATIONS
} = {}) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) throw new Error('There is no connected token to store in the website.');
  const usable = TOKEN_VAULT_SLOTS.filter(slot => String(passwords?.[slot] || ''));
  if (!usable.length) {
    throw new Error('Sign in again so the token can be locked with your administrator password before it is stored in the website.');
  }

  const rounds = safeIterations(iterations);
  const dataKeyBytes = randomBytes(DATA_KEY_BYTES);
  const dataKey = await importDataKey(dataKeyBytes);
  const sealedToken = await seal(dataKey, new TextEncoder().encode(cleanToken), 'token');

  const slots = {};
  for (const slot of usable) {
    const salt = randomBytes(SALT_BYTES);
    const slotKey = await deriveSlotKey(passwords[slot], salt, rounds);
    const wrapped = await seal(slotKey, dataKeyBytes, `slot:${slot}`);
    slots[slot] = {
      salt: encodeBase64(salt),
      iv: wrapped.iv,
      data: wrapped.data,
      // The config.js salt in force when this slot was written. It is already
      // public; recording it lets the site spot a vault that predates a
      // password rotation instead of just failing to open.
      gate: String(gates?.[slot] || '')
    };
  }
  dataKeyBytes.fill(0);

  return {
    _comment: [...TOKEN_VAULT_COMMENT],
    version: TOKEN_VAULT_VERSION,
    updatedAt: new Date().toISOString(),
    repository: String(repository || ''),
    cipher: CIPHER,
    kdf: { name: KDF_NAME, hash: KDF_HASH, iterations: rounds },
    token: sealedToken,
    slots
  };
}

/**
 * Decrypt the stored token with one administrator password.
 *
 * `slot` is tried first and the remaining slots afterwards, so the same typed
 * password works whether it is the sign-in password or the master password.
 * A wrong password throws an error tagged `code: 'locked'`.
 */
export async function openTokenVault(vault, { password, slot = '' } = {}) {
  if (!isTokenVault(vault)) {
    const error = new Error('This website does not have a stored publishing token yet.');
    error.code = 'missing';
    throw error;
  }
  const secret = String(password || '');
  if (!secret) {
    const error = new Error('Enter your administrator password to unlock the stored token.');
    error.code = 'locked';
    throw error;
  }
  const available = tokenVaultSlots(vault);
  const order = [slot, ...available].filter((name, index, list) =>
    name && available.includes(name) && list.indexOf(name) === index);
  const rounds = safeIterations(vault?.kdf?.iterations);

  for (const name of order) {
    const entry = vault.slots[name];
    let dataKeyBytes = null;
    try {
      const slotKey = await deriveSlotKey(secret, decodeBase64(entry.salt), rounds);
      dataKeyBytes = await unseal(slotKey, entry, `slot:${name}`);
      const dataKey = await importDataKey(dataKeyBytes);
      const plaintext = await unseal(dataKey, vault.token, 'token');
      const opened = new TextDecoder().decode(plaintext).trim();
      if (!opened) continue;
      return { token: opened, slot: name };
    } catch {
      // Wrong password for this slot, or tampered ciphertext: try the next.
    } finally {
      dataKeyBytes?.fill?.(0);
    }
  }

  const error = new Error('That password did not unlock the token stored in this website. It may have been saved with a previous password — save the token again from Cloud Settings.');
  error.code = 'locked';
  throw error;
}
