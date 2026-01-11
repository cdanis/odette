// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2025 Chris Danis

// src/routes/admin.ts
// Admin routes for event management

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDatabase, getEventAttendeeStats, type EventRecord, type EventRecordWithStats } from '../database';
import { getTimezones } from '../utils';
import * as path from 'path';
import * as fs from 'fs';

const router = Router();

// ============================================================================
// Admin Dashboard
// ============================================================================

/**
 * List all events with stats
 */
router.get('/', (req: Request, res: Response) => {
  const db = getDatabase();
  const eventsRaw = db.prepare('SELECT * FROM events ORDER BY date').all() as EventRecord[];
  const events: EventRecordWithStats[] = eventsRaw.map(event => ({
    ...event,
    stats: getEventAttendeeStats(event.id)
  }));
  res.render('admin', { events, csrfToken: req.csrfToken(), timezones: getTimezones() });
});

/**
 * View single event admin page with attendees
 */
router.get('/:eventId', (req: Request, res: Response) => {
  const eventId = +req.params.eventId;
  const db = getDatabase();
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as EventRecord | undefined;
  
  if (!event) {
    res.status(404).send('Event not found');
    return;
  }
  
  const attendees = db.prepare(
    'SELECT id, event_id, name, email, party_size, token, is_sent, rsvp, responded_at, last_modified, additional_emails FROM attendees WHERE event_id = ? ORDER BY name'
  ).all(eventId);
  
  const allEvents = db.prepare('SELECT id, title FROM events WHERE id != ? ORDER BY title').all(eventId) as {id: number, title: string}[];
  const attendeeStats = getEventAttendeeStats(eventId);

  res.render('event-admin', { 
    event, 
    attendees, 
    allEvents, 
    attendeeStats, 
    csrfToken: req.csrfToken(), 
    timezones: getTimezones() 
  });
});

// ============================================================================
// Event CRUD Operations
// ============================================================================

/**
 * Create a new event
 */
router.post('/event', (req: Request, res: Response) => {
  const { title, date, description, location_name, location_href, date_end, timezone } = req.body;
  const dateTimestamp = new Date(date).getTime();
  let dateEndTimestamp: number | null = null;
  
  if (date_end) {
    const parsedEnd = new Date(date_end).getTime();
    if (!isNaN(parsedEnd)) {
      dateEndTimestamp = parsedEnd;
    }
  }
  
  const db = getDatabase();
  const result = db.prepare(
    'INSERT INTO events (title, date, description, banner_image_filename, location_name, location_href, date_end, timezone) VALUES (?,?,?,?,?,?,?,?)'
  ).run(title, dateTimestamp, description, null, location_name || null, location_href || null, dateEndTimestamp, timezone || null);
  
  const eventId = result.lastInsertRowid;

  // Handle file upload if present
  if (req.file && eventId) {
    const eventBannerPath = process.env.EVENT_BANNER_STORAGE_PATH || './data/uploads/event-banners';
    const tempMulterFilename = req.file.filename; 
    const finalFilename = `event-${eventId}-${Date.now()}${path.extname(req.file.originalname)}`;
    
    const oldPath = path.join(eventBannerPath, tempMulterFilename);
    const newPath = path.join(eventBannerPath, finalFilename);

    fs.rename(oldPath, newPath, (err) => {
      if (err) {
        console.error("Error renaming uploaded file for new event:", err);
      } else {
        db.prepare('UPDATE events SET banner_image_filename = ? WHERE id = ?')
          .run(finalFilename, eventId);
      }
      res.redirect('/admin');
    });
  } else {
    res.redirect('/admin');
  }
});

/**
 * Update an existing event
 */
router.post('/event/:eventId/update', (req: Request, res: Response) => {
  const eventId = +req.params.eventId;
  const { title, date, description, location_name, location_href, date_end, timezone } = req.body;
  const dateTimestamp = new Date(date).getTime();
  let dateEndTimestamp: number | null = null;
  
  if (date_end) {
    const parsedEnd = new Date(date_end).getTime();
    if (!isNaN(parsedEnd)) {
      dateEndTimestamp = parsedEnd;
    }
  }

  const db = getDatabase();
  const currentEventData = db.prepare('SELECT banner_image_filename FROM events WHERE id = ?').get(eventId) as { banner_image_filename?: string | null };

  if (req.file) {
    const eventBannerPath = process.env.EVENT_BANNER_STORAGE_PATH || './data/uploads/event-banners';
    const newBannerFilename = req.file.filename; 
    
    // Delete old banner if it exists
    if (currentEventData && currentEventData.banner_image_filename) {
      const oldBannerPath = path.join(eventBannerPath, currentEventData.banner_image_filename);
      fs.unlink(oldBannerPath, (err) => {
        if (err && err.code !== 'ENOENT') { 
          console.error(`Failed to delete old banner image ${oldBannerPath}:`, err);
        } else if (!err) {
          console.log(`Deleted old banner image ${oldBannerPath}`);
        }
      });
    }
    
    db.prepare(
      'UPDATE events SET title = ?, date = ?, description = ?, banner_image_filename = ?, location_name = ?, location_href = ?, date_end = ?, timezone = ? WHERE id = ?'
    ).run(title, dateTimestamp, description, newBannerFilename, location_name || null, location_href || null, dateEndTimestamp, timezone || null, eventId);
  } else {
    db.prepare(
      'UPDATE events SET title = ?, date = ?, description = ?, location_name = ?, location_href = ?, date_end = ?, timezone = ? WHERE id = ?'
    ).run(title, dateTimestamp, description, location_name || null, location_href || null, dateEndTimestamp, timezone || null, eventId);
  }
  
  res.redirect(`/admin/${eventId}`);
});

export default router;
