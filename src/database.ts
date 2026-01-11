// src/database.ts
// Database initialization, migrations, types, and data access layer

import * as Database from 'better-sqlite3';

// ============================================================================
// Types
// ============================================================================

export type EventRecord = { 
  id: number; 
  title: string; 
  date: number; 
  description: string | null; 
  banner_image_filename?: string | null; 
  location_name?: string | null;
  location_href?: string | null;
  date_end?: number | null;
  timezone?: string | null;
};

export type AttendeeView = { 
  id: number; 
  event_id: number; 
  name: string; 
  email: string; // Primary email
  party_size: number; 
  is_sent: number; 
  rsvp: string | null; 
  responded_at: number | null; 
  event_title: string; 
  event_date: number; 
  event_desc: string | null; 
  token: string; 
  event_banner_image_filename?: string | null; 
  event_location_name?: string | null;
  event_location_href?: string | null;
  event_date_end?: number | null;
  event_timezone?: string | null; 
  additional_emails?: string | null; // JSON string
};

export type EventAttendeeView = { 
  id: number; 
  event_id: number; 
  name: string; 
  email: string; // Primary email
  party_size: number; 
  token: string; 
  is_sent: number; 
  rsvp: string | null; 
  responded_at: number | null; 
  last_modified: number | null;
  additional_emails?: string | null; // JSON string
};

export interface AttendeeStats {
  potentialGuests: number;
  guestsNotSent: number;
  guestsInvited: number;
  guestsAwaitingReply: number;
  guestsAttending: number;
  guestsNotAttending: number;
}

interface ExistingAttendee { 
  id: number; 
  party_size: number; 
  additional_emails?: string | null; // JSON string
}

export type EventRecordWithStats = EventRecord & { stats: AttendeeStats };

// ============================================================================
// Database Connection
// ============================================================================

let database: Database.Database;

/**
 * Initialize database connection and run migrations
 * @param dbPath Path to SQLite database file (or ':memory:' for testing)
 * @returns Database instance
 */
export function initializeDatabase(dbPath: string): Database.Database {
  database = new Database.default(dbPath);
  
  // Create tables if they don't exist
  database.prepare(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    date INTEGER NOT NULL,
    description TEXT,
    banner_image_filename TEXT,
    location_name TEXT,
    location_href TEXT,
    date_end INTEGER,
    timezone TEXT
  )`).run();

  database.prepare(`CREATE TABLE IF NOT EXISTS attendees (
    id INTEGER PRIMARY KEY,
    event_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    party_size INTEGER NOT NULL DEFAULT 1,
    token TEXT NOT NULL UNIQUE,
    is_sent INTEGER NOT NULL DEFAULT 0,
    rsvp TEXT DEFAULT NULL,
    responded_at INTEGER DEFAULT NULL,
    last_modified INTEGER,
    additional_emails TEXT,
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
  )`).run();

  // Run migrations for events table
  const columnsToAddEvents = [
    { name: 'banner_image_filename', type: 'TEXT' },
    { name: 'location_name', type: 'TEXT' },
    { name: 'location_href', type: 'TEXT' },
    { name: 'date_end', type: 'INTEGER' },
    { name: 'timezone', type: 'TEXT' }
  ];

  columnsToAddEvents.forEach(col => {
    try {
      database.prepare(`SELECT ${col.name} FROM events LIMIT 1`).get();
    } catch (error) {
      console.log(`Attempting to add ${col.name} column to events table...`);
      try {
        database.prepare(`ALTER TABLE events ADD COLUMN ${col.name} ${col.type}`).run();
        console.log(`Column ${col.name} added successfully.`);
      } catch (alterError) {
        console.error(`Failed to add ${col.name} column:`, alterError);
      }
    }
  });

  // Run migrations for attendees table
  try {
    database.prepare(`SELECT last_modified FROM attendees LIMIT 1`).get();
  } catch (error) {
    console.log(`Attempting to add last_modified column to attendees table...`);
    try {
      database.prepare(`ALTER TABLE attendees ADD COLUMN last_modified INTEGER`).run();
      console.log(`Column last_modified added successfully to attendees table.`);
    } catch (alterError) {
      console.error(`Failed to add last_modified column to attendees:`, alterError);
    }
  }

  try {
    database.prepare(`SELECT additional_emails FROM attendees LIMIT 1`).get();
  } catch (error) {
    console.log(`Attempting to add additional_emails column to attendees table...`);
    try {
      database.prepare(`ALTER TABLE attendees ADD COLUMN additional_emails TEXT CHECK(json_valid(additional_emails) AND json_type(additional_emails) IN ('array', 'null'))`).run();
      console.log(`Column additional_emails added successfully to attendees table.`);
    } catch (alterError) {
      console.error(`Failed to add additional_emails column to attendees:`, alterError);
    }
  }

  return database;
}

/**
 * Get the database instance
 * @returns Database instance
 */
export function getDatabase(): Database.Database {
  if (!database) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return database;
}

// ============================================================================
// Data Access Functions
// ============================================================================

/**
 * Upsert an attendee - creates if doesn't exist, updates if exists
 * This is the ONLY way to create/update attendees to ensure consistency
 * 
 * @param event_id Event ID
 * @param name Attendee name
 * @param primaryEmail Primary email (will be trimmed and lowercased)
 * @param party_size Party size (optional, defaults to 1, only updated if no RSVP exists)
 * @param additionalEmailsArray Array of additional CC emails (optional, undefined preserves existing)
 */
export function upsertAttendee(
  event_id: number, 
  name: string, 
  primaryEmail: string, 
  party_size?: number, 
  additionalEmailsArray?: string[]
): void {
  const db = getDatabase();
  const stmtSelect = db.prepare('SELECT id, party_size, additional_emails FROM attendees WHERE event_id=? AND email=?');
  const trimmedPrimaryEmail = primaryEmail.trim().toLowerCase();
  const existing = stmtSelect.get(event_id, trimmedPrimaryEmail) as ExistingAttendee | undefined;
  const finalPartySize = party_size === undefined || isNaN(party_size) || party_size < 1 ? 1 : party_size;
  const now = Date.now();

  // Prepare additional_emails JSON string only if additionalEmailsArray is provided.
  // If additionalEmailsArray is undefined, additionalEmailsJson will also be undefined,
  // signaling that the additional_emails field should not be modified for existing attendees.
  let additionalEmailsJson: string | null | undefined = undefined;
  if (additionalEmailsArray !== undefined) {
    const uniqueAdditionalEmails = [...new Set(
      additionalEmailsArray
        .map(e => e.trim().toLowerCase())
        .filter(e => e && e !== trimmedPrimaryEmail)
    )];
    additionalEmailsJson = uniqueAdditionalEmails.length > 0 ? JSON.stringify(uniqueAdditionalEmails) : null;
  }

  if (existing) {
    const attendeeId = existing.id;
    const rsvpStatus = db.prepare('SELECT rsvp FROM attendees WHERE id = ?').get(attendeeId) as { rsvp: string | null } | undefined;
    
    let updateQuery = 'UPDATE attendees SET last_modified=?';
    const updateParams: (number | string | null)[] = [now];

    // Update name if provided
    if (name) {
      updateQuery += ', name=?';
      updateParams.push(name);
    }

    if (rsvpStatus && rsvpStatus.rsvp === null) { // Only update party size if no RSVP yet
      if (party_size !== undefined && existing.party_size !== finalPartySize) {
        updateQuery += ', party_size=?';
        updateParams.push(finalPartySize);
      }
    }
    
    // Only update additional_emails if additionalEmailsArray was provided (making additionalEmailsJson defined)
    // and the new value is different from the existing one.
    if (additionalEmailsJson !== undefined) {
      if (additionalEmailsJson !== existing.additional_emails) {
        updateQuery += ', additional_emails=?';
        updateParams.push(additionalEmailsJson);
      }
    }
    
    updateParams.push(attendeeId);

    // Run update (last_modified always updates, other fields conditionally)
    db.prepare(`${updateQuery} WHERE id=?`).run(...updateParams);
  } else {
    const { generateToken } = require('./utils');
    const token = generateToken();
    // For new attendees, if additionalEmailsJson is undefined (because array wasn't passed),
    // it defaults to null for the database insert.
    const finalAdditionalEmailsJsonForInsert = additionalEmailsJson === undefined ? null : additionalEmailsJson;
    db.prepare('INSERT INTO attendees (event_id,name,email,party_size,token,last_modified,additional_emails) VALUES (?,?,?,?,?,?,?)')
      .run(event_id, name, trimmedPrimaryEmail, finalPartySize, token, now, finalAdditionalEmailsJsonForInsert);
  }
}

/**
 * Get attendee statistics for an event
 * @param eventId Event ID
 * @returns Statistics about attendees and RSVPs
 */
export function getEventAttendeeStats(eventId: number): AttendeeStats {
  const db = getDatabase();
  const stats: AttendeeStats = {
    potentialGuests: 0,
    guestsNotSent: 0,
    guestsInvited: 0,
    guestsAwaitingReply: 0,
    guestsAttending: 0,
    guestsNotAttending: 0,
  };

  const potentialGuestsRow = db.prepare('SELECT SUM(party_size) as sum_party FROM attendees WHERE event_id = ?').get(eventId) as { sum_party: number | null };
  stats.potentialGuests = potentialGuestsRow?.sum_party ?? 0;

  const notSentRow = db.prepare('SELECT SUM(party_size) as sum_party FROM attendees WHERE event_id = ? AND is_sent = 0').get(eventId) as { sum_party: number | null };
  stats.guestsNotSent = notSentRow?.sum_party ?? 0;

  const invitedRow = db.prepare('SELECT SUM(party_size) as sum_party FROM attendees WHERE event_id = ? AND is_sent = 1').get(eventId) as { sum_party: number | null };
  stats.guestsInvited = invitedRow?.sum_party ?? 0;
  
  const awaitingReplyRow = db.prepare('SELECT SUM(party_size) as sum_party FROM attendees WHERE event_id = ? AND is_sent = 1 AND rsvp IS NULL').get(eventId) as { sum_party: number | null };
  stats.guestsAwaitingReply = awaitingReplyRow?.sum_party ?? 0;

  const attendingRow = db.prepare("SELECT SUM(party_size) as sum_party FROM attendees WHERE event_id = ? AND is_sent = 1 AND rsvp = 'yes'").get(eventId) as { sum_party: number | null };
  stats.guestsAttending = attendingRow?.sum_party ?? 0;

  const notAttendingRow = db.prepare("SELECT SUM(party_size) as sum_party FROM attendees WHERE event_id = ? AND is_sent = 1 AND rsvp = 'no'").get(eventId) as { sum_party: number | null };
  stats.guestsNotAttending = notAttendingRow?.sum_party ?? 0;

  return stats;
}
