/* eslint-disable */
import * as crypto from 'crypto';

/**
 * AES-256-GCM envelope encryption for user-supplied LLM API keys (BYOK) at
 * rest. The master key comes from LLM_CONFIG_ENCRYPTION_KEY and never leaves
 * the process; the ciphertext stored in the llm_configs table is
 * authenticated (GCM tag), so a wrong master key or tampered row fails
 * loudly instead of silently decrypting to garbage.
 *
 * Stored format: "v1:<iv-b64>:<authTag-b64>:<ciphertext-b64>" — versioned so
 * the scheme can evolve (e.g. key rotation) without guessing old rows.
 */

const KEY_LENGTH_BYTES = 32;

/** Thrown for missing/invalid master keys or undecryptable stored secrets. */
export class LlmConfigCryptoError extends Error {}

/**
 * Resolves the master key from the raw env value. Accepts a 32-byte key
 * encoded as base64 (44 chars) or hex (64 chars):
 *
 *   openssl rand -base64 32
 *   openssl rand -hex 32
 */
export function resolveMasterKey(envValue: string | undefined): Buffer {
  if (!envValue || !envValue.trim()) {
    throw new LlmConfigCryptoError(
      'LLM_CONFIG_ENCRYPTION_KEY is not set. Generate one with ' +
        '`openssl rand -base64 32` and set it in your environment. ' +
        'It must encode exactly 32 bytes (base64 or hex). BYOK key storage ' +
        'is disabled until this is configured.',
    );
  }
  const raw = envValue.trim();
  for (const encoding of ['base64', 'hex'] as const) {
    const buf = Buffer.from(raw, encoding);
    if (buf.length === KEY_LENGTH_BYTES) return buf;
  }
  throw new LlmConfigCryptoError(
    `LLM_CONFIG_ENCRYPTION_KEY must encode exactly 32 bytes as base64 or hex ` +
      `(got ${raw.length} characters). Generate one with \`openssl rand -base64 32\`.`,
  );
}

/** Encrypts a secret into the versioned envelope format described above. */
export function encryptSecret(plaintext: string, masterKey: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/** Decrypts a secret produced by encryptSecret. Throws on tamper/wrong key. */
export function decryptSecret(stored: string, masterKey: Buffer): string {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new LlmConfigCryptoError(
      'Unrecognized encrypted secret format (expected "v1:iv:tag:ciphertext")',
    );
  }
  const [, ivB64, tagB64, ctB64] = parts;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      masterKey,
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (e: any) {
    // getAuthTag verification failure — wrong master key or tampered row.
    throw new LlmConfigCryptoError(
      `Could not decrypt stored API key (wrong LLM_CONFIG_ENCRYPTION_KEY or tampered row): ${e?.message ?? e}`,
    );
  }
}
