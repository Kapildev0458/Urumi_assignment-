// Password hashing, API keys, session tokens and credential encryption, with Node's crypto only.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

function scryptAsync(password: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, length, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** scrypt with a random salt, stored as "scrypt:<salt>:<hash>" (base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 32);
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

/**
 * API keys and session tokens are 32 random bytes, so plain SHA-256 is enough to store them:
 * unlike passwords they cannot be guessed, and a fast hash keeps every MCP request cheap.
 */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function newApiKey(): { key: string; prefix: string; hash: string } {
  const key = `ugw_${randomBytes(32).toString('base64url')}`;
  return { key, prefix: key.slice(0, 12), hash: sha256(key) };
}

export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

/** AES-256-GCM, stored as "v1:<iv>:<tag>:<ciphertext>" (base64). */
export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

export function decrypt(stored: string, key: Buffer): string {
  const [version, iv, tag, data] = stored.split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unknown credential format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
