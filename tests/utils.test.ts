// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2025 Chris Danis

import { generateToken, isValidToken, deriveNameFromEmail, parseCsvTsvLine } from '../src/utils';

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

describe('deriveNameFromEmail', () => {
  it('uses provided name when available', () => {
    expect(deriveNameFromEmail({ name: 'John Doe', address: 'john@example.com' })).toBe('John Doe');
  });

  it('derives name from email username', () => {
    expect(deriveNameFromEmail({ address: 'john.doe@example.com' })).toBe('john doe');
  });

  it('strips periods from derived names', () => {
    expect(deriveNameFromEmail({ address: 'first.middle.last@example.com' })).toBe('first middle last');
  });

  it('strips quotes from derived names', () => {
    expect(deriveNameFromEmail({ address: '"john.doe"@example.com' })).toBe('john doe');
  });

  it('strips apostrophes from derived names', () => {
    expect(deriveNameFromEmail({ address: "john'doe@example.com" })).toBe('john doe');
  });

  it('returns empty string when no address provided', () => {
    expect(deriveNameFromEmail({})).toBe('');
  });

  it('handles malformed email without @ symbol', () => {
    expect(deriveNameFromEmail({ address: 'notanemail' })).toBe('notanemail');
  });
});

describe('parseCsvTsvLine', () => {
  describe('CSV format (comma-separated)', () => {
    it('parses email and name from basic CSV', () => {
      const result = parseCsvTsvLine('John Doe,john@example.com');
      expect(result).toEqual({ email: 'john@example.com', name: 'John Doe', party_size: 1 });
    });

    it('parses with email first, name second', () => {
      const result = parseCsvTsvLine('alice@example.com,Alice Wonder');
      expect(result).toEqual({ email: 'alice@example.com', name: 'Alice Wonder', party_size: 1 });
    });

    it('parses with only email (derives name)', () => {
      const result = parseCsvTsvLine('john.doe@example.com');
      expect(result).toEqual({ email: 'john.doe@example.com', name: 'john doe', party_size: 1 });
    });

    it('strips quotes from values', () => {
      const result = parseCsvTsvLine('"John Doe","john@example.com"');
      expect(result).toEqual({ email: 'john@example.com', name: 'John Doe', party_size: 1 });
    });

    it('strips single quotes from values', () => {
      const result = parseCsvTsvLine("'Jane Smith','jane@example.com'");
      expect(result).toEqual({ email: 'jane@example.com', name: 'Jane Smith', party_size: 1 });
    });

    it('handles extra whitespace', () => {
      const result = parseCsvTsvLine('  John Doe  ,  john@example.com  ');
      expect(result).toEqual({ email: 'john@example.com', name: 'John Doe', party_size: 1 });
    });

    it('uses first non-email column as name', () => {
      const result = parseCsvTsvLine('John Doe,123-456-7890,john@example.com');
      expect(result).toEqual({ email: 'john@example.com', name: 'John Doe', party_size: 1 });
    });

    it('handles multiple emails (uses first)', () => {
      const result = parseCsvTsvLine('alice@example.com,bob@example.com,Alice');
      expect(result).toEqual({ email: 'alice@example.com', name: 'Alice', party_size: 2 });
    });
  });

  describe('TSV format (tab-separated)', () => {
    it('parses email and name from TSV', () => {
      const result = parseCsvTsvLine('John Doe\tjohn@example.com');
      expect(result).toEqual({ email: 'john@example.com', name: 'John Doe', party_size: 1 });
    });

    it('detects TSV over CSV when tab present', () => {
      const result = parseCsvTsvLine('Name,Has,Commas\tjohn@example.com');
      expect(result).toEqual({ email: 'john@example.com', name: 'Name,Has,Commas', party_size: 1 });
    });

    it('handles TSV with extra columns', () => {
      const result = parseCsvTsvLine('Alice\tWonder\talice@example.com\t555-1234');
      expect(result).toEqual({ email: 'alice@example.com', name: 'Alice', party_size: 1 });
    });
  });

  describe('edge cases', () => {
    it('returns null for empty string', () => {
      expect(parseCsvTsvLine('')).toBeNull();
    });

    it('returns null for whitespace-only string', () => {
      expect(parseCsvTsvLine('   ')).toBeNull();
    });

    it('returns null when no email found', () => {
      expect(parseCsvTsvLine('John Doe,123 Main St,555-1234')).toBeNull();
    });

    it('derives name when only email present with extra commas', () => {
      const result = parseCsvTsvLine(',,john.doe@example.com,,');
      expect(result).toEqual({ email: 'john.doe@example.com', name: 'john doe', party_size: 1 });
    });

    it('handles email with plus addressing', () => {
      const result = parseCsvTsvLine('john+test@example.com,John');
      expect(result).toEqual({ email: 'john+test@example.com', name: 'John', party_size: 1 });
    });

    it('handles email with subdomain', () => {
      const result = parseCsvTsvLine('john@mail.example.com,John');
      expect(result).toEqual({ email: 'john@mail.example.com', name: 'John', party_size: 1 });
    });

    it('ignores invalid email-like strings', () => {
      const result = parseCsvTsvLine('notanemail@,John Doe');
      expect(result).toBeNull();
    });

    it('handles names with commas in quotes', () => {
      const result = parseCsvTsvLine('"Doe, John",john@example.com');
      expect(result).toEqual({ email: 'john@example.com', name: 'Doe, John', party_size: 1 });
    });

    it('handles unicode characters', () => {
      const result = parseCsvTsvLine('José García,jose@example.com');
      expect(result).toEqual({ email: 'jose@example.com', name: 'José García', party_size: 1 });
    });
  });

  describe('real-world examples', () => {
    it('parses Google Contacts export format', () => {
      const result = parseCsvTsvLine('John,Doe,john@example.com,Company Name');
      expect(result).toEqual({ email: 'john@example.com', name: 'John', party_size: 1 });
    });

    it('parses Outlook export format', () => {
      const result = parseCsvTsvLine('"Doe, John",john@example.com,555-1234');
      expect(result).toEqual({ email: 'john@example.com', name: 'Doe, John', party_size: 1 });
    });

    it('parses simple email list', () => {
      const result = parseCsvTsvLine('alice@example.com');
      expect(result).toEqual({ email: 'alice@example.com', name: 'alice', party_size: 1 });
    });
  });

  describe('party_size counting from email addresses', () => {
    it('sets party_size to 1 for single email', () => {
      const result = parseCsvTsvLine('John Doe,john@example.com');
      expect(result).toEqual({ email: 'john@example.com', name: 'John Doe', party_size: 1 });
    });

    it('sets party_size to 2 for two emails', () => {
      const result = parseCsvTsvLine('Smith Family,john@example.com,jane@example.com');
      expect(result).toEqual({ email: 'john@example.com', name: 'Smith Family', party_size: 2 });
    });

    it('sets party_size to 3 for three emails', () => {
      const result = parseCsvTsvLine('Team Name,one@example.com,two@example.com,three@example.com');
      expect(result).toEqual({ email: 'one@example.com', name: 'Team Name', party_size: 3 });
    });

    it('counts only valid emails for party_size', () => {
      const result = parseCsvTsvLine('Group,valid@example.com,not-an-email,another@example.com,555-1234');
      expect(result).toEqual({ email: 'valid@example.com', name: 'Group', party_size: 2 });
    });

    it('handles TSV with multiple emails', () => {
      const result = parseCsvTsvLine('Couple\thusband@example.com\twife@example.com');
      expect(result).toEqual({ email: 'husband@example.com', name: 'Couple', party_size: 2 });
    });

    it('handles quoted emails in party_size counting', () => {
      const result = parseCsvTsvLine('"Family Name","primary@example.com","secondary@example.com"');
      expect(result).toEqual({ email: 'primary@example.com', name: 'Family Name', party_size: 2 });
    });

    it('handles mix of quoted and unquoted emails', () => {
      const result = parseCsvTsvLine('Partners,alice@example.com,"bob@example.com",charlie@example.com');
      expect(result).toEqual({ email: 'alice@example.com', name: 'Partners', party_size: 3 });
    });

    it('sets party_size to 1 when deriving name from single email', () => {
      const result = parseCsvTsvLine('solo@example.com');
      expect(result).toEqual({ email: 'solo@example.com', name: 'solo', party_size: 1 });
    });

    it('handles emails with special characters in party counting', () => {
      const result = parseCsvTsvLine('Group,john+tag@example.com,jane+tag@example.com');
      expect(result).toEqual({ email: 'john+tag@example.com', name: 'Group', party_size: 2 });
    });

    it('handles multiple emails with no explicit name field', () => {
      const result = parseCsvTsvLine('first@example.com,second@example.com,third@example.com');
      // First email becomes both the primary and derives the name
      expect(result).toEqual({ email: 'first@example.com', name: 'first', party_size: 3 });
    });
  });
});
