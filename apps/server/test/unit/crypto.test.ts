import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  hmacSha256Hex,
  maskSecret,
  safeEqual,
  verifyPassword,
} from '../../src/lib/crypto.js';
import { TEST_ENCRYPTION_KEY } from '../helpers/test-env.js';

describe('encryptSecret / decryptSecret', () => {
  it('round-trips arbitrary content', () => {
    const secret = JSON.stringify({ botToken: '12345:AbCdEf_secret-token', note: 'юникод ✓' });
    const enc = encryptSecret(secret, TEST_ENCRYPTION_KEY);
    expect(enc).toMatch(/^v1:/);
    expect(enc).not.toContain('12345');
    expect(decryptSecret(enc, TEST_ENCRYPTION_KEY)).toBe(secret);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const a = encryptSecret('same', TEST_ENCRYPTION_KEY);
    const b = encryptSecret('same', TEST_ENCRYPTION_KEY);
    expect(a).not.toBe(b);
  });

  it('rejects tampered ciphertext', () => {
    const enc = encryptSecret('secret', TEST_ENCRYPTION_KEY);
    const parts = enc.split(':');
    const data = Buffer.from(parts[3]!, 'base64');
    data[0] = data[0]! ^ 0xff;
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${data.toString('base64')}`;
    expect(() => decryptSecret(tampered, TEST_ENCRYPTION_KEY)).toThrow();
  });

  it('rejects the wrong key', () => {
    const enc = encryptSecret('secret', TEST_ENCRYPTION_KEY);
    expect(() => decryptSecret(enc, 'b'.repeat(64))).toThrow();
  });
});

describe('password hashing', () => {
  it('verifies the correct password and rejects wrong ones', async () => {
    const hash = await hashPassword('s3cure-Passw0rd!');
    expect(hash).toMatch(/^scrypt:/);
    expect(await verifyPassword('s3cure-Passw0rd!', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('s3cure-Passw0rd!', 'garbage')).toBe(false);
  });
});

describe('safeEqual', () => {
  it('compares equal and unequal strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('hmacSha256Hex', () => {
  it('matches RFC 4231 test case 2', () => {
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });
});

describe('maskSecret', () => {
  it('never reveals the middle of a secret', () => {
    expect(maskSecret('1234567890abcdef')).toBe('1234••••••••cdef');
    expect(maskSecret('short')).toBe('••••••••');
    expect(maskSecret('')).toBe('');
  });
});
