// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2025 Chris Danis

/**
 * tests/timezone.test.ts
 * Jest tests for timezone handling in event creation and updates
 */

// Ensure in-memory DB before importing modules
process.env.DB_PATH = ':memory:';

import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { initializeDatabase, getDatabase } from '../src/database';

// Initialize database for tests
initializeDatabase(':memory:');
const db = getDatabase();

describe('Timezone handling with date-fns-tz', () => {
  describe('fromZonedTime', () => {
    it('correctly converts timezone-local datetime string to UTC timestamp', () => {
      // 2026-01-15 19:00 in America/Los_Angeles
      const dateString = '2026-01-15T19:00';
      const timezone = 'America/Los_Angeles';
      
      const utcDate = fromZonedTime(dateString, timezone);
      const timestamp = utcDate.getTime();
      
      // Convert back to verify
      const zonedDate = toZonedTime(timestamp, timezone);
      expect(zonedDate.getHours()).toBe(19);
      expect(zonedDate.getMinutes()).toBe(0);
      expect(zonedDate.getDate()).toBe(15);
    });

    it('handles different timezones correctly', () => {
      const dateString = '2026-01-15T19:00';
      
      const pstTimestamp = fromZonedTime(dateString, 'America/Los_Angeles').getTime();
      const estTimestamp = fromZonedTime(dateString, 'America/New_York').getTime();
      const utcTimestamp = fromZonedTime(dateString, 'UTC').getTime();
      
      // PST is 8 hours behind UTC, EST is 5 hours behind
      // So 7pm PST should be 3 hours later than 7pm EST
      expect(pstTimestamp - estTimestamp).toBe(3 * 60 * 60 * 1000);
      
      // 7pm UTC should be earlier than both
      expect(utcTimestamp).toBeLessThan(estTimestamp);
      expect(utcTimestamp).toBeLessThan(pstTimestamp);
    });

    it('handles daylight saving time transitions', () => {
      // March 9, 2026 is when DST starts in US (2am -> 3am)
      // Before DST: 2026-03-08 14:00 PST
      const beforeDST = fromZonedTime('2026-03-08T14:00', 'America/Los_Angeles').getTime();
      
      // After DST: 2026-03-10 14:00 PDT
      const afterDST = fromZonedTime('2026-03-10T14:00', 'America/Los_Angeles').getTime();
      
      // Difference should be 48 hours (2 days), not 49
      const diffHours = (afterDST - beforeDST) / (1000 * 60 * 60);
      expect(diffHours).toBe(48);
    });
  });

  describe('Event storage with timezones', () => {
    beforeEach(() => {
      db.prepare('DELETE FROM events').run();
    });

    it('stores event with Pacific timezone correctly', () => {
      const dateString = '2026-01-15T19:00';
      const timezone = 'America/Los_Angeles';
      const timestamp = fromZonedTime(dateString, timezone).getTime();
      
      db.prepare('INSERT INTO events (title, date, timezone) VALUES (?, ?, ?)')
        .run('Test Event', timestamp, timezone);
      
      const event = db.prepare('SELECT * FROM events WHERE title = ?')
        .get('Test Event') as { date: number; timezone: string };
      
      expect(event.date).toBe(timestamp);
      expect(event.timezone).toBe(timezone);
      
      // Verify we can convert back to local time
      const zonedDate = toZonedTime(event.date, event.timezone);
      expect(zonedDate.getHours()).toBe(19);
      expect(zonedDate.getMinutes()).toBe(0);
    });

    it('stores event with Eastern timezone correctly', () => {
      const dateString = '2026-01-15T19:00';
      const timezone = 'America/New_York';
      const timestamp = fromZonedTime(dateString, timezone).getTime();
      
      db.prepare('INSERT INTO events (title, date, timezone) VALUES (?, ?, ?)')
        .run('Test Event EST', timestamp, timezone);
      
      const event = db.prepare('SELECT * FROM events WHERE title = ?')
        .get('Test Event EST') as { date: number; timezone: string };
      
      const zonedDate = toZonedTime(event.date, event.timezone);
      expect(zonedDate.getHours()).toBe(19);
    });

    it('handles event with start and end times in same timezone', () => {
      const timezone = 'America/Los_Angeles';
      const startString = '2026-01-15T19:00';
      const endString = '2026-01-15T22:00';
      
      const startTimestamp = fromZonedTime(startString, timezone).getTime();
      const endTimestamp = fromZonedTime(endString, timezone).getTime();
      
      db.prepare('INSERT INTO events (title, date, date_end, timezone) VALUES (?, ?, ?, ?)')
        .run('Multi-hour Event', startTimestamp, endTimestamp, timezone);
      
      const event = db.prepare('SELECT * FROM events WHERE title = ?')
        .get('Multi-hour Event') as { date: number; date_end: number; timezone: string };
      
      // Verify duration is 3 hours
      const durationMs = event.date_end - event.date;
      expect(durationMs).toBe(3 * 60 * 60 * 1000);
      
      // Verify times in local timezone
      const startZoned = toZonedTime(event.date, event.timezone);
      const endZoned = toZonedTime(event.date_end, event.timezone);
      
      expect(startZoned.getHours()).toBe(19);
      expect(endZoned.getHours()).toBe(22);
    });

    it('handles multi-day event across timezone boundaries', () => {
      const timezone = 'America/Los_Angeles';
      const startString = '2026-01-15T19:00';
      const endString = '2026-01-16T02:00'; // 2am next day
      
      const startTimestamp = fromZonedTime(startString, timezone).getTime();
      const endTimestamp = fromZonedTime(endString, timezone).getTime();
      
      db.prepare('INSERT INTO events (title, date, date_end, timezone) VALUES (?, ?, ?, ?)')
        .run('Overnight Event', startTimestamp, endTimestamp, timezone);
      
      const event = db.prepare('SELECT * FROM events WHERE title = ?')
        .get('Overnight Event') as { date: number; date_end: number; timezone: string };
      
      // Verify duration is 7 hours
      const durationMs = event.date_end - event.date;
      expect(durationMs).toBe(7 * 60 * 60 * 1000);
    });

    it('handles events in UTC timezone', () => {
      const dateString = '2026-01-15T19:00';
      const timezone = 'UTC';
      const timestamp = fromZonedTime(dateString, timezone).getTime();
      
      db.prepare('INSERT INTO events (title, date, timezone) VALUES (?, ?, ?)')
        .run('UTC Event', timestamp, timezone);
      
      const event = db.prepare('SELECT * FROM events WHERE title = ?')
        .get('UTC Event') as { date: number; timezone: string };
      
      const zonedDate = toZonedTime(event.date, event.timezone);
      expect(zonedDate.getHours()).toBe(19);
      expect(zonedDate.getMinutes()).toBe(0);
    });

    it('handles events in Asia/Tokyo timezone', () => {
      const dateString = '2026-01-15T19:00';
      const timezone = 'Asia/Tokyo';
      const timestamp = fromZonedTime(dateString, timezone).getTime();
      
      db.prepare('INSERT INTO events (title, date, timezone) VALUES (?, ?, ?)')
        .run('Tokyo Event', timestamp, timezone);
      
      const event = db.prepare('SELECT * FROM events WHERE title = ?')
        .get('Tokyo Event') as { date: number; timezone: string };
      
      const zonedDate = toZonedTime(event.date, event.timezone);
      expect(zonedDate.getHours()).toBe(19);
    });

    it('correctly compares same wall-clock time in different timezones', () => {
      const dateString = '2026-01-15T19:00';
      
      const pstTimestamp = fromZonedTime(dateString, 'America/Los_Angeles').getTime();
      const tokyoTimestamp = fromZonedTime(dateString, 'Asia/Tokyo').getTime();
      
      // Tokyo is 17 hours ahead of PST
      // So 7pm Tokyo is 17 hours before 7pm PST
      const diffHours = (pstTimestamp - tokyoTimestamp) / (1000 * 60 * 60);
      expect(diffHours).toBe(17);
    });
  });

  describe('Edge cases', () => {
    it('handles event at midnight', () => {
      const timezone = 'America/Los_Angeles';
      const dateString = '2026-01-15T00:00';
      const timestamp = fromZonedTime(dateString, timezone).getTime();
      
      const zonedDate = toZonedTime(timestamp, timezone);
      expect(zonedDate.getHours()).toBe(0);
      expect(zonedDate.getMinutes()).toBe(0);
    });

    it('handles event just before midnight', () => {
      const timezone = 'America/Los_Angeles';
      const dateString = '2026-01-15T23:59';
      const timestamp = fromZonedTime(dateString, timezone).getTime();
      
      const zonedDate = toZonedTime(timestamp, timezone);
      expect(zonedDate.getHours()).toBe(23);
      expect(zonedDate.getMinutes()).toBe(59);
    });

    it('handles leap year date', () => {
      const timezone = 'America/New_York';
      const dateString = '2024-02-29T19:00'; // 2024 was a leap year
      const timestamp = fromZonedTime(dateString, timezone).getTime();
      
      const zonedDate = toZonedTime(timestamp, timezone);
      expect(zonedDate.getDate()).toBe(29);
      expect(zonedDate.getMonth()).toBe(1); // February (0-indexed)
    });
  });
});
