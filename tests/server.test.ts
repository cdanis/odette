/**
 * tests/server.test.ts
 * Jest tests for RSVP system helpers
 */

// Ensure in-memory DB before importing server
process.env.DB_PATH = ':memory:';
import { generateToken, upsertAttendee, db } from '../src/server';

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

describe('upsertAttendee', () => {
  const eventId = 1;

  beforeAll(() => {
    // Tables are auto-created by server import
    // Insert a dummy event
    db.prepare('INSERT INTO events (id, title, date, description) VALUES (?, ?, ?, ?)')
      .run(eventId, 'Test Event', Date.now(), 'Desc');
  });

  afterEach(() => {
    // Clear attendees table
    db.prepare('DELETE FROM attendees').run();
  });

  it('inserts a new attendee when none exists', () => {
    upsertAttendee(eventId, 'Alice', 'alice@example.com', 2);
    const row = db.prepare('SELECT * FROM attendees WHERE email = ?').get('alice@example.com');
    expect(row).toBeDefined();
    expect(row.name).toBe('Alice');
    expect(row.party_size).toBe(2);
    expect(row.token).toHaveLength(32);
  });

  it('updates party_size if attendee already exists', () => {
    upsertAttendee(eventId, 'Bob', 'bob@example.com', 1);
    const before = db.prepare('SELECT party_size FROM attendees WHERE email = ?').get('bob@example.com');
    expect(before.party_size).toBe(1);

    // Update to party_size 4
    upsertAttendee(eventId, 'Bob', 'bob@example.com', 4);
    const after = db.prepare('SELECT party_size FROM attendees WHERE email = ?').get('bob@example.com');
    expect(after.party_size).toBe(4);
  });

  it('does not change party_size if unchanged', () => {
    upsertAttendee(eventId, 'Carol', 'carol@example.com', 3);
    const before = db.prepare('SELECT party_size FROM attendees WHERE email = ?').get('carol@example.com');
    upsertAttendee(eventId, 'Carol', 'carol@example.com', 3);
    const after = db.prepare('SELECT party_size FROM attendees WHERE email = ?').get('carol@example.com');
    expect(after.party_size).toBe(before.party_size);
  });
});
