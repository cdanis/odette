import { generateToken } from '../src/utils';

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
