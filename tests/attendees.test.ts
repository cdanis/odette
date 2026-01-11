/**
 * tests/attendees.test.ts
 * Jest tests for attendee management helpers
 */

// Ensure in-memory DB before importing modules
process.env.DB_PATH = ':memory:';
process.env.SMTP_USER = 'test@example.com';
process.env.SMTP_PASS = 'testpass';

import { parseCCEmails, sendAndMarkInvitation } from '../src/routes/attendees';
import { initializeDatabase, getDatabase } from '../src/database';
import type { EventRecord } from '../src/database';

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
