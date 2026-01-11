/**
 * tests/server.test.ts
 * Jest tests for RSVP system helpers
 */

// Ensure in-memory DB before importing modules
process.env.DB_PATH = ':memory:';
import { upsertAttendee, initializeDatabase, getDatabase } from '../src/database';

// Initialize database for tests
initializeDatabase(':memory:');
const db = getDatabase();

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
    upsertAttendee(eventId, 'Daphne', 'd@d.c', 2);
    const dRow = db.prepare('SELECT * FROM attendees WHERE email = ?').get('d@d.c') as any;
    expect(dRow).toBeDefined();
    expect(dRow.name).toBe('Daphne');
    expect(dRow.party_size).toBe(2);
    expect(dRow.token).toHaveLength(32);
    expect(dRow.event_id).toBe(eventId);
    expect(dRow.last_modified).toBeGreaterThan(0);
  });

  it('uses a default party_size of 1 if not provided', () => {
    upsertAttendee(eventId, 'Alice', 'alice@example.com');
    const row = db.prepare('SELECT * FROM attendees WHERE email = ?').get('alice@example.com') as any;
    expect(row).toBeDefined();
    expect(row.name).toBe('Alice');
    expect(row.party_size).toBe(1); // Default party size
    expect(row.token).toHaveLength(32);
  });

  it('updates party_size if attendee already exists', () => {
    upsertAttendee(eventId, 'Bob', 'bob@example.com', 1);
    const before = db.prepare('SELECT party_size FROM attendees WHERE email = ?').get('bob@example.com') as any;
    expect(before.party_size).toBe(1);

    // Update to party_size 4
    upsertAttendee(eventId, 'Bob', 'bob@example.com', 4);
    const after = db.prepare('SELECT party_size FROM attendees WHERE email = ?').get('bob@example.com') as any;
    expect(after.party_size).toBe(4);
  });

  it('does not change party_size if unchanged, but updates last_modified', () => {
    upsertAttendee(eventId, 'Carol', 'carol@example.com', 3);
    const before = db.prepare('SELECT party_size, last_modified FROM attendees WHERE email = ?').get('carol@example.com') as any;
    for (let i = 0; i < 100; i++) {  //hack
      upsertAttendee(eventId, 'Carol', 'carol@example.com', 3);
    }
    const after = db.prepare('SELECT party_size, last_modified FROM attendees WHERE email = ?').get('carol@example.com') as any;
    expect(after.party_size).toBe(before.party_size);
    expect(after.last_modified).toBeGreaterThan(before.last_modified);
  });

  it('updates name when a non-empty name is provided', () => {
    upsertAttendee(eventId, 'john', 'john@example.com', 1);
    const before = db.prepare('SELECT name FROM attendees WHERE email = ?').get('john@example.com') as any;
    expect(before.name).toBe('john');

    // Update with better name
    upsertAttendee(eventId, 'John Doe', 'john@example.com', 1);
    const after = db.prepare('SELECT name FROM attendees WHERE email = ?').get('john@example.com') as any;
    expect(after.name).toBe('John Doe');
  });

  it('preserves existing name when empty string is provided', () => {
    upsertAttendee(eventId, 'Jane Smith', 'jane@example.com', 1);
    const before = db.prepare('SELECT name FROM attendees WHERE email = ?').get('jane@example.com') as any;
    expect(before.name).toBe('Jane Smith');

    // Update with empty name (should preserve existing)
    upsertAttendee(eventId, '', 'jane@example.com', 2);
    const after = db.prepare('SELECT name, party_size FROM attendees WHERE email = ?').get('jane@example.com') as any;
    expect(after.name).toBe('Jane Smith');
    expect(after.party_size).toBe(2); // Other fields should still update
  });
});
