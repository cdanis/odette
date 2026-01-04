import { generateToken, isValidToken } from '../src/utils';

describe('generateToken', () => {
  it('returns a 32-character hex string', () => {
    const token = generateToken();
    expect(typeof token).toBe('string');
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('returns unique tokens on subsequent calls', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });
});

describe('isValidToken', () => {
  it('returns true for a valid 32-character hex string', () => {
    const validToken = generateToken();
    expect(isValidToken(validToken)).toBe(true);
  });

  it('returns true for a manually created valid token', () => {
    expect(isValidToken('0123456789abcdef0123456789abcdef')).toBe(true);
  });

  it('returns false for non-hex characters', () => {
    expect(isValidToken('0123456789abcdefg123456789abcdef')).toBe(false);
  });

  it('returns false for strings shorter than 32 characters', () => {
    expect(isValidToken('0123456789abcdef0123456789abcde')).toBe(false);
  });

  it('returns false for strings longer than 32 characters', () => {
    expect(isValidToken('0123456789abcdef0123456789abcdef0')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isValidToken('')).toBe(false);
  });

  it('returns false for strings with spaces', () => {
    expect(isValidToken('0123456789abcdef 0123456789abcde')).toBe(false);
  });
});
