// パスワードのハッシュと、LINEトークンの暗号化保存
import { scrypt as _scrypt, randomBytes, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt);

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 32);
  return `s1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function checkPassword(pw, stored) {
  const [v, s, k] = String(stored || '').split('$');
  if (v !== 's1') return false;
  const want = Buffer.from(k, 'base64url');
  const got = await scrypt(pw, Buffer.from(s, 'base64url'), want.length);
  return timingSafeEqual(got, want);
}

export const token = (n = 24) => randomBytes(n).toString('base64url');
export const sha = (s) => createHash('sha256').update(s).digest('base64url');

function key() {
  const k = process.env.APP_SECRET;
  return k ? createHash('sha256').update(k).digest() : null;
}

// APP_SECRET があれば AES-256-GCM で暗号化して保存する
export function seal(plain) {
  const k = key();
  if (!plain || !k) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `e1:${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
}

export function unseal(sealed) {
  if (!sealed || !sealed.startsWith('e1:')) return sealed || '';
  const k = key();
  if (!k) throw new Error('APP_SECRET が未設定のため保存済みトークンを復号できません');
  const b = Buffer.from(sealed.slice(3), 'base64');
  const d = createDecipheriv('aes-256-gcm', k, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
