// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2025 Chris Danis

// src/routes/public.ts
// Public-facing routes (landing page, RSVP, ICS download)

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDatabase, type AttendeeView } from '../database';
import { notifyAdmin } from '../notifications';
import { formatICSDate, escapeICSText, isValidToken } from '../utils';

const router = Router();

// ============================================================================
// Landing Page
// ============================================================================

router.get('/', (req: Request, res: Response) => {
  res.render('landing');
});

// ============================================================================
// RSVP Routes
// ============================================================================

/**
 * Display RSVP form for a given token
 */
router.get('/rsvp/:tok', (req: Request, res: Response) => {
  if (!isValidToken(req.params.tok)) {
    res.status(400).send('Invalid token format');
    return;
  }
  
  const db = getDatabase();
  const attendee = db.prepare(
    `SELECT a.*, 
            e.title AS event_title, 
            e.date as event_date, 
            e.description as event_desc,
            e.banner_image_filename AS event_banner_image_filename,
            e.location_name AS event_location_name,
            e.location_href AS event_location_href,
            e.date_end AS event_date_end,
            e.timezone AS event_timezone
     FROM attendees a 
     JOIN events e ON a.event_id=e.id 
     WHERE a.token=?`
  ).get(req.params.tok) as AttendeeView | undefined; 

  if (!attendee) {
    res.status(404).send('Invalid link');
    return;
  }
  
  res.render('rsvp', { attendee, csrfToken: req.csrfToken() });
});

/**
 * Process RSVP submission
 */
router.post('/rsvp/:token', async (req: Request, res: Response) => {
  if (!isValidToken(req.params.token)) {
    res.status(400).send('Invalid token format');
    return;
  }
  
  const { rsvp, party_size: partySizeStr } = req.body;
  const now = Date.now();
  const db = getDatabase();
  
  const attendeeData = db.prepare(
    `SELECT a.name, a.token, a.party_size AS original_party_size, 
            e.title AS event_title 
     FROM attendees a 
     JOIN events e ON a.event_id=e.id 
     WHERE a.token=?`
  ).get(req.params.token) as { name: string; token: string; event_title: string; original_party_size: number; } | undefined;

  if (!attendeeData) {
    res.status(404).send('Invalid token or attendee not found.');
    return;
  }

  let finalPartySize = attendeeData.original_party_size; 

  if (rsvp === 'yes') {
    const parsedPartySize = parseInt(partySizeStr, 10);
    if (isNaN(parsedPartySize) || parsedPartySize < 1) {
      res.status(400).send('Invalid party size for RSVP "yes". Please go back and enter a valid number.');
      return;
    }
    finalPartySize = parsedPartySize;
  }

  db.prepare('UPDATE attendees SET rsvp=?, party_size=?, responded_at=?, last_modified=? WHERE token=?')
    .run(rsvp, finalPartySize, now, now, req.params.token);
  
  await notifyAdmin(attendeeData, rsvp, (rsvp === 'yes' ? finalPartySize : 0));
  
  res.render('thanks', { 
    rsvp, 
    party_size: (rsvp === 'yes' ? finalPartySize : 0),
    token: req.params.token,
    event_title: attendeeData.event_title,
  });
});

// ============================================================================
// ICS File Download
// ============================================================================

/**
 * Generate and download ICS calendar file for an event
 */
router.get('/ics/:token', async (req: Request, res: Response) => {
  if (!isValidToken(req.params.token)) {
    res.status(400).send('Invalid token format');
    return;
  }

  const db = getDatabase();
  const eventDataForICS = db.prepare(
    `SELECT e.id AS event_id,
            e.title AS event_title, 
            e.date AS event_date, 
            e.description AS event_desc,
            e.location_name AS event_location_name,
            e.location_href AS event_location_href,
            e.date_end AS event_date_end
     FROM attendees a 
     JOIN events e ON a.event_id=e.id 
     WHERE a.token=?`
  ).get(req.params.token) as { 
    event_id: number;
    event_title: string; 
    event_date: number; 
    event_desc: string | null; 
    event_location_name: string | null;
    event_location_href: string | null;
    event_date_end: number | null;
  } | undefined;

  if (!eventDataForICS) {
    res.status(404).send('Event details not found for this token.');
    return;
  }

  const { 
    event_id,
    event_title, 
    event_date, 
    event_desc, 
    event_location_name, 
    event_location_href,
    event_date_end 
  } = eventDataForICS;

  const now = Date.now();
  const dtstamp = formatICSDate(now);
  const dtstart = formatICSDate(event_date);
  
  // Extract domain from APP_BASE_URL for UID
  const appBaseUrl = req.app.locals.APP_BASE_URL || `http://localhost:${process.env.PORT || '3000'}`;
  const domain = appBaseUrl.replace(/^https?:\/\//, '').split('/')[0];
  const rsvpLink = `${appBaseUrl}/rsvp/${req.params.token}`;

  let icsContent = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${domain}//NONSGML Event Calendar//EN`,
    'BEGIN:VEVENT',
    `UID:event-${event_id}@${domain}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dtstart}`,
  ];

  if (event_date_end) {
    icsContent.push(`DTEND:${formatICSDate(event_date_end)}`);
  }

  icsContent.push(`SUMMARY:${escapeICSText(event_title)}`);

  if (event_location_href) {
    icsContent.push(`URL:${escapeICSText(event_location_href)}`);
  }
  
  let descriptionForICS = event_desc || '';
  descriptionForICS += `\n\nManage your RSVP or view event details: ${rsvpLink}`;
  icsContent.push(`DESCRIPTION:${escapeICSText(descriptionForICS, true)}`);

  if (event_location_name) {
    icsContent.push(`LOCATION:${escapeICSText(event_location_name)}`);
  }
  
  icsContent.push('END:VEVENT');
  icsContent.push('END:VCALENDAR');
  icsContent.push(''); 

  const filenameSafeTitle = (event_title || 'event').replace(/[^a-z0-9_.-]/gi, '_').substring(0, 50);
  
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameSafeTitle}.ics"`);
  res.send(icsContent.join('\r\n'));
});

export default router;
