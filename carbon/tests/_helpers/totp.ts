import { createHmac } from 'node:crypto';

/**
 * The current code for an authenticator-app URI (otpauth://totp/...?secret=),
 * computed the way an authenticator app does (RFC 6238: HMAC-SHA1, 30 s
 * period, 6 digits, the defaults the twoFactor plugin uses).
 */
export function totpCode(totpURI: string, at = Date.now()): string {
  const secret = new URL(totpURI).searchParams.get('secret');
  if (!secret) throw new Error('TOTP URI has no secret');
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const value = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return value.toString().padStart(6, '0');
}

/** A code that is certainly wrong now (the right one, shifted by one digit). */
export function wrongTotpCode(totpURI: string): string {
  const right = totpCode(totpURI);
  return right
    .split('')
    .map((d) => String((Number(d) + 5) % 10))
    .join('');
}

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error('invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
