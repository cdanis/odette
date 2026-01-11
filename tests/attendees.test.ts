// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2025 Chris Danis

/**
 * tests/attendees.test.ts
 * Jest tests for attendee management helpers
 */

// Ensure in-memory DB before importing modules
process.env.DB_PATH = ':memory:';
process.env.SMTP_USER = 'test@example.com';
process.env.SMTP_PASS = 'testpass';

import { parseCCEmails, sendAndMarkInvitation } from '../src/routes/attendees';
import { initializeDatabase, getDatabase, upsertAttendee } from '../src/database';
import type { EventRecord } from '../src/database';
import { deriveNameFromEmail } from '../src/utils';
import addressparser from 'addressparser';

// Mock the notifications module
jest.mock('../src/notifications', () => ({
  sendInvitation: jest.fn().mockResolvedValue(undefined),
}));

import { sendInvitation } from '../src/notifications';

// Initialize database for tests
initializeDatabase(':memory:');
const db = getDatabase();

describe('parseCCEmails', () => {
  it('returns empty array when additionalEmailsJson is null', () => {
    const result = parseCCEmails(null, 'primary@example.com', 1);
    expect(result).toEqual([]);
  });

  it('returns empty array when additionalEmailsJson is empty string', () => {
    const result = parseCCEmails('', 'primary@example.com', 1);
    expect(result).toEqual([]);
  });

  it('parses valid JSON array of emails', () => {
    const json = JSON.stringify(['friend@example.com', 'colleague@example.com']);
    const result = parseCCEmails(json, 'primary@example.com', 1);
    expect(result).toEqual(['friend@example.com', 'colleague@example.com']);
  });

  it('filters out primary email from CC list', () => {
    const json = JSON.stringify(['primary@example.com', 'friend@example.com']);
    const result = parseCCEmails(json, 'primary@example.com', 1);
    expect(result).toEqual(['friend@example.com']);
  });

  it('trims and lowercases emails', () => {
    const json = JSON.stringify(['  Friend@Example.COM  ', 'Colleague@Test.ORG']);
    const result = parseCCEmails(json, 'primary@example.com', 1);
    expect(result).toEqual(['friend@example.com', 'colleague@test.org']);
  });

  it('filters out empty strings', () => {
    const json = JSON.stringify(['friend@example.com', '', '  ', 'colleague@example.com']);
    const result = parseCCEmails(json, 'primary@example.com', 1);
    expect(result).toEqual(['friend@example.com', 'colleague@example.com']);
  });

  it('handles invalid JSON gracefully', () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    const result = parseCCEmails('not valid json', 'primary@example.com', 1);
    expect(result).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('returns empty array when parsed JSON is not an array', () => {
    const json = JSON.stringify({ email: 'test@example.com' });
    const result = parseCCEmails(json, 'primary@example.com', 1);
    expect(result).toEqual([]);
  });

  it('handles mixed-case primary email matching', () => {
    const json = JSON.stringify(['PRIMARY@EXAMPLE.COM', 'friend@example.com']);
    const result = parseCCEmails(json, 'primary@example.com', 1);
    expect(result).toEqual(['friend@example.com']);
  });
});

describe('sendAndMarkInvitation', () => {
  const mockSendInvitation = sendInvitation as jest.MockedFunction<typeof sendInvitation>;

  beforeAll(() => {
    // Create a test event
    db.prepare('INSERT INTO events (id, title, date, description) VALUES (?, ?, ?, ?)')
      .run(1, 'Test Event', Date.now(), 'Test Description');
  });

  beforeEach(() => {
    // Clear attendees table
    db.prepare('DELETE FROM attendees').run();
    mockSendInvitation.mockClear();
  });

  it('throws error when attendee has no email', async () => {
    const attendee = {
      id: 1,
      name: 'Test User',
      email: '',
      token: 'abc123',
      event_id: 1,
      additional_emails: null,
    };

    const event: EventRecord = {
      id: 1,
      title: 'Test Event',
      date: Date.now(),
      description: 'Test',
    };

    await expect(
      sendAndMarkInvitation(attendee, event, 'http://localhost:3000')
    ).rejects.toThrow('Primary email missing for attendee ID 1');
  });

  it('sends invitation and marks attendee as sent', async () => {
    // Insert attendee
    db.prepare('INSERT INTO attendees (id, event_id, name, email, party_size, token, is_sent) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(1, 1, 'Test User', 'test@example.com', 1, 'abc123', 0);

    const attendee = {
      id: 1,
      name: 'Test User',
      email: 'test@example.com',
      token: 'abc123',
      event_id: 1,
      additional_emails: null,
    };

    const event: EventRecord = {
      id: 1,
      title: 'Test Event',
      date: Date.now(),
      description: 'Test',
    };

    await sendAndMarkInvitation(attendee, event, 'http://localhost:3000');

    // Verify sendInvitation was called with correct params
    expect(mockSendInvitation).toHaveBeenCalledWith(
      'Test User',
      'test@example.com',
      [],
      'abc123',
      event,
      'http://localhost:3000'
    );

    // Verify attendee is marked as sent
    const updatedAttendee = db.prepare('SELECT is_sent, last_modified FROM attendees WHERE id = ?').get(1) as { is_sent: number; last_modified: number };
    expect(updatedAttendee.is_sent).toBe(1);
    expect(updatedAttendee.last_modified).toBeGreaterThan(0);
  });

  it('sends invitation with CC emails when additional_emails exists', async () => {
    const ccEmails = ['friend@example.com', 'colleague@example.com'];
    const additionalEmailsJson = JSON.stringify(ccEmails);

    // Insert attendee
    db.prepare('INSERT INTO attendees (id, event_id, name, email, party_size, token, is_sent, additional_emails) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(1, 1, 'Test User', 'test@example.com', 1, 'abc123', 0, additionalEmailsJson);

    const attendee = {
      id: 1,
      name: 'Test User',
      email: 'test@example.com',
      token: 'abc123',
      event_id: 1,
      additional_emails: additionalEmailsJson,
    };

    const event: EventRecord = {
      id: 1,
      title: 'Test Event',
      date: Date.now(),
      description: 'Test',
    };

    await sendAndMarkInvitation(attendee, event, 'http://localhost:3000');

    // Verify sendInvitation was called with CC emails
    expect(mockSendInvitation).toHaveBeenCalledWith(
      'Test User',
      'test@example.com',
      ccEmails,
      'abc123',
      event,
      'http://localhost:3000'
    );
  });

  it('trims and lowercases primary email before sending', async () => {
    // Insert attendee with uppercase email
    db.prepare('INSERT INTO attendees (id, event_id, name, email, party_size, token, is_sent) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(1, 1, 'Test User', '  TEST@EXAMPLE.COM  ', 1, 'abc123', 0);

    const attendee = {
      id: 1,
      name: 'Test User',
      email: '  TEST@EXAMPLE.COM  ',
      token: 'abc123',
      event_id: 1,
      additional_emails: null,
    };

    const event: EventRecord = {
      id: 1,
      title: 'Test Event',
      date: Date.now(),
      description: 'Test',
    };

    await sendAndMarkInvitation(attendee, event, 'http://localhost:3000');

    // Verify sendInvitation was called with normalized email
    expect(mockSendInvitation).toHaveBeenCalledWith(
      'Test User',
      'test@example.com',
      [],
      'abc123',
      event,
      'http://localhost:3000'
    );
  });

  it('filters primary email from CC list', async () => {
    const additionalEmailsJson = JSON.stringify(['test@example.com', 'friend@example.com']);

    // Insert attendee
    db.prepare('INSERT INTO attendees (id, event_id, name, email, party_size, token, is_sent, additional_emails) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(1, 1, 'Test User', 'test@example.com', 1, 'abc123', 0, additionalEmailsJson);

    const attendee = {
      id: 1,
      name: 'Test User',
      email: 'test@example.com',
      token: 'abc123',
      event_id: 1,
      additional_emails: additionalEmailsJson,
    };

    const event: EventRecord = {
      id: 1,
      title: 'Test Event',
      date: Date.now(),
      description: 'Test',
    };

    await sendAndMarkInvitation(attendee, event, 'http://localhost:3000');

    // Verify primary email was filtered out from CC
    expect(mockSendInvitation).toHaveBeenCalledWith(
      'Test User',
      'test@example.com',
      ['friend@example.com'],
      'abc123',
      event,
      'http://localhost:3000'
    );
  });
});

describe('Email parsing and attendee creation', () => {
  beforeAll(() => {
    // Ensure test event exists
    const existingEvent = db.prepare('SELECT id FROM events WHERE id = ?').get(999);
    if (!existingEvent) {
      db.prepare('INSERT INTO events (id, title, date, description) VALUES (?, ?, ?, ?)')
        .run(999, 'Parse Test Event', Date.now(), 'Testing email parsing');
    }
  });

  beforeEach(() => {
    // Clear attendees for the test event
    db.prepare('DELETE FROM attendees WHERE event_id = ?').run(999);
  });

  describe('name derivation from email', () => {
    it('uses provided name when available', () => {
      const derivedName = deriveNameFromEmail({ name: 'John Doe', address: 'john@example.com' });
      expect(derivedName).toBe('John Doe');
    });

    it('derives name from email username when no name provided', () => {
      const derivedName = deriveNameFromEmail({ address: 'john.doe@example.com' });
      expect(derivedName).toBe('john doe');
    });

    it('strips periods from derived names', () => {
      const derivedName = deriveNameFromEmail({ address: 'first.middle.last@example.com' });
      expect(derivedName).toBe('first middle last');
    });

    it('strips quotes from derived names', () => {
      const derivedName = deriveNameFromEmail({ address: '"john.doe"@example.com' });
      expect(derivedName).toBe('john doe');
    });

    it('strips apostrophes from derived names', () => {
      const derivedName = deriveNameFromEmail({ address: "john'doe@example.com" });
      expect(derivedName).toBe('john doe');
    });

    it('returns empty string when no address provided', () => {
      const derivedName = deriveNameFromEmail({});
      expect(derivedName).toBe('');
    });

    it('handles malformed email without @ symbol', () => {
      const derivedName = deriveNameFromEmail({ address: 'notanemail' });
      expect(derivedName).toBe('notanemail');
    });
  });

  describe('attendee creation from parsed emails', () => {
    it('creates attendee with provided name', () => {
      const parsed = addressparser('"Alice Wonder" <alice@example.com>');
      const p = parsed[0];
      const name = deriveNameFromEmail(p);
      
      upsertAttendee(999, name, p.address!, 1, []);

      const attendee = db.prepare('SELECT name, email, party_size FROM attendees WHERE event_id = ? AND email = ?')
        .get(999, 'alice@example.com') as { name: string; email: string; party_size: number };
      
      expect(attendee).toEqual({ name: 'Alice Wonder', email: 'alice@example.com', party_size: 1 });
    });

    it('creates attendee with derived name when no name provided', () => {
      const parsed = addressparser('john.doe@example.com');
      const p = parsed[0];
      const name = deriveNameFromEmail(p);
      
      upsertAttendee(999, name, p.address!, 1, []);

      const attendee = db.prepare('SELECT name, email, party_size FROM attendees WHERE event_id = ? AND email = ?')
        .get(999, 'john.doe@example.com') as { name: string; email: string; party_size: number };
      
      expect(attendee.name).toBe('john doe');
    });

    it('sets party_size to 1 by default', () => {
      const parsed = addressparser('test@example.com');
      const p = parsed[0];
      const name = deriveNameFromEmail(p);
      
      upsertAttendee(999, name, p.address!, 1, []);

      const attendee = db.prepare('SELECT party_size FROM attendees WHERE event_id = ? AND email = ?')
        .get(999, 'test@example.com') as { party_size: number };
      
      expect(attendee.party_size).toBe(1);
    });

    it('sets additional_emails to empty array', () => {
      const parsed = addressparser('test@example.com');
      const p = parsed[0];
      const name = deriveNameFromEmail(p);
      
      upsertAttendee(999, name, p.address!, 1, []);

      const attendee = db.prepare('SELECT additional_emails FROM attendees WHERE event_id = ? AND email = ?')
        .get(999, 'test@example.com') as { additional_emails: string | null };
      
      expect(attendee.additional_emails).toBeNull();
    });

    it('creates multiple attendees from batch input', () => {
      const parsed = addressparser('"Alice" <alice@example.com>, bob@test.org, "Charlie" <charlie@example.com>');
      
      parsed.forEach(p => {
        if (p.address) {
          const name = deriveNameFromEmail(p);
          upsertAttendee(999, name, p.address, 1, []);
        }
      });

      const count = db.prepare('SELECT COUNT(*) as count FROM attendees WHERE event_id = ?')
        .get(999) as { count: number };
      
      expect(count.count).toBe(3);
    });

    it('handles duplicate emails via upsert (updates name)', () => {
      const parsed1 = addressparser('john@example.com');
      const p1 = parsed1[0];
      upsertAttendee(999, deriveNameFromEmail(p1), p1.address!, 1, []);

      const parsed2 = addressparser('"John Doe" <john@example.com>');
      const p2 = parsed2[0];
      upsertAttendee(999, deriveNameFromEmail(p2), p2.address!, 1, []);

      const attendees = db.prepare('SELECT name, email FROM attendees WHERE event_id = ?')
        .all(999) as { name: string; email: string }[];
      
      expect(attendees).toHaveLength(1);
      expect(attendees[0]).toEqual({ name: 'John Doe', email: 'john@example.com' });
    });
  });
});
