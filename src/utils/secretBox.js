import crypto from 'crypto';

// AES-256-GCM for secrets we must be able to read back (client portal passwords).
// The key comes from CREDENTIALS_KEY, falling back to JWT_SECRET. Changing it makes
// already-saved secrets unreadable, so set it once and keep it.
const key = () => crypto.createHash('sha256').update(process.env.CREDENTIALS_KEY || process.env.JWT_SECRET || '').digest();

export function encrypt(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decrypt(box) {
  if (!box) return '';
  try {
    const [iv, tag, data] = box.split('.').map((s) => Buffer.from(s, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null; // saved with a different key
  }
}
