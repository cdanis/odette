// src/routes/attendees.ts
// Attendee management routes

import { Router } from 'express';
import type { Request, Response } from 'express';
import addressparser from 'addressparser';
import { getDatabase, upsertAttendee, type EventRecord } from '../database';
import { sendInvitation } from '../notifications';

const router = Router();

// ============================================================================
// Helper interfaces
// ============================================================================

interface InviteeWithEventIdAndEmails { 
  id: number; 
  name: string; 
  email: string;
  token: string; 
  event_id: number; 
  additional_emails: string | null;
}

// ============================================================================
// Attendee CRUD Operations
// ============================================================================

/**
 * Add a single attendee
 */
router.post('/attendee', (req: Request, res: Response) => {
  const eventId = +req.body.event_id;
  const partySize = parseInt(req.body.party_size, 10);
  const primaryEmail = req.body.email;
  const additionalEmailsRaw = req.body.additional_emails || '';
  
  let additionalEmailsList: string[] = [];
  if (additionalEmailsRaw && typeof additionalEmailsRaw === 'string') {
    additionalEmailsList = additionalEmailsRaw
      .split(/[\n,]+/)
      .map(e => e.trim())
      .filter(e => e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  }

  upsertAttendee(eventId, req.body.name, primaryEmail, isNaN(partySize) || partySize < 1 ? 1 : partySize, additionalEmailsList);
  res.redirect(`/admin/${eventId}`);
});

/**
 * Batch add attendees from CSV
 */
router.post('/attendees/batch', (req: Request, res: Response) => {
  const eventId = +req.body.event_id;
  req.body.csv.split(/\r?\n/).forEach((line: string) => {
    const [name, email, partyStr] = line.split(',').map((s: string) => s.trim());
    if (name && email) {
      const party = parseInt(partyStr, 10);
      upsertAttendee(eventId, name, email, isNaN(party) || party < 1 ? 1 : party, []);
    }
  });
  res.redirect(`/admin/${eventId}`);
});

/**
 * Parse emails from clipboard (e.g., from email "To:" field)
 */
router.post('/event/:eventId/attendees/parse-emails', (req: Request, res: Response) => {
  const eventId = +req.params.eventId;
  const emailFieldData = req.body.email_field_data as string;

  if (!emailFieldData) {
    return res.redirect(`/admin/${eventId}`);
  }

  try {
    const parsedAddresses = addressparser(emailFieldData);
    parsedAddresses.forEach(parsed => {
      if (parsed.address) {
        const email = parsed.address;
        const name = parsed.name || email.substring(0, email.lastIndexOf('@')).replace(/[."']/g, ' ').trim();
        upsertAttendee(eventId, name, email, 1, []); 
      }
    });
  } catch (error) {
    console.error("Error parsing email field data:", error);
  }

  res.redirect(`/admin/${eventId}`);
});

/**
 * Copy attendees from one event to another
 */
router.post('/attendees/copy', (req: Request, res: Response) => {
  const fromEventId = +req.body.from_event;
  const toEventId = +req.body.to_event;
  const db = getDatabase();
  const rows = db.prepare('SELECT name, email, party_size, additional_emails FROM attendees WHERE event_id=?')
    .all(fromEventId) as {name: string, email: string, party_size: number, additional_emails: string | null}[];
  
  rows.forEach((r) => {
    let additionalEmailsList: string[] = [];
    if (r.additional_emails) {
      try {
        const parsedEmails = JSON.parse(r.additional_emails);
        if (Array.isArray(parsedEmails)) {
          additionalEmailsList = parsedEmails.filter(e => typeof e === 'string');
        }
      } catch (e) {
        console.error(`Error parsing additional_emails JSON for attendee ${r.email} from event ${fromEventId}:`, e);
      }
    }
    upsertAttendee(toEventId, r.name, r.email, r.party_size, additionalEmailsList);
  });
  res.redirect(`/admin/${toEventId}`);
});

/**
 * Update attendee party size (only allowed before RSVP)
 */
router.post('/attendee/:attendeeId/update-party-size', (req: Request, res: Response) => {
  const attendeeId = +req.params.attendeeId;
  const newPartySize = parseInt(req.body.party_size, 10);
  const db = getDatabase();

  const attendeeInfo = db.prepare('SELECT event_id, rsvp FROM attendees WHERE id = ?')
    .get(attendeeId) as { event_id: number; rsvp: string | null } | undefined;

  if (!attendeeInfo) {
    console.warn(`Attempt to update party size for non-existent attendee ID ${attendeeId}`);
    res.status(404).send('Attendee not found.');
    return;
  }

  if (isNaN(newPartySize) || newPartySize < 1) {
    console.warn(`Invalid party size submitted for attendee ${attendeeId}: ${req.body.party_size}. Redirecting.`);
    res.redirect(`/admin/${attendeeInfo.event_id}`);
    return;
  }

  if (attendeeInfo.rsvp !== null) {
    console.warn(`Attempt to update party size for attendee ${attendeeId} who has already RSVP'd. No update performed. Redirecting.`);
    res.redirect(`/admin/${attendeeInfo.event_id}`);
    return ;
  }
  
  const existingAttendee = db.prepare('SELECT name, email FROM attendees WHERE id = ?').get(attendeeId) as { name: string, email: string } | undefined;
  if (!existingAttendee) {
    console.error(`Could not retrieve existing attendee data for ID ${attendeeId} during party size update.`);
    res.status(500).send('Error updating party size.');
    return;
  }

  upsertAttendee(attendeeInfo.event_id, existingAttendee.name, existingAttendee.email, newPartySize, undefined);
  res.redirect(`/admin/${attendeeInfo.event_id}`);
});

/**
 * Update attendee name and emails
 */
router.post('/attendee/:attendeeId/update-emails', (async (req: Request, res: Response) => {
  const attendeeId = +req.params.attendeeId;
  const { name: newNameRaw, primaryEmail: newPrimaryEmailRaw, additionalEmails: additionalEmailsRaw } = req.body;
  const now = Date.now();
  const db = getDatabase();

  const newName = (newNameRaw || '').toString().trim();
  const newPrimaryEmail = (newPrimaryEmailRaw || '').toString().trim().toLowerCase();

  let eventIdForRedirect: number | undefined;
  try {
    const attendeeForEventId = db.prepare('SELECT event_id FROM attendees WHERE id = ?').get(attendeeId) as {event_id: number} | undefined;
    if (!attendeeForEventId) {
      console.error(`Attendee with ID ${attendeeId} not found for redirect.`);
      return res.status(404).send('Attendee not found.');
    }
    eventIdForRedirect = attendeeForEventId.event_id;

    if (!newName) {
      return res.redirect(`/admin/${eventIdForRedirect}?error=${encodeURIComponent('Name cannot be empty.')}`);
    }
    if (!newPrimaryEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newPrimaryEmail)) {
      return res.redirect(`/admin/${eventIdForRedirect}?error=${encodeURIComponent('Invalid or missing primary email format.')}`);
    }
  
    let newAdditionalEmailsList: string[] = [];
    if (additionalEmailsRaw && typeof additionalEmailsRaw === 'string') {
      newAdditionalEmailsList = additionalEmailsRaw
        .split(/[\n\r]+/) 
        .map(e => e.trim().toLowerCase())
        .filter(e => e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e !== newPrimaryEmail); 
    }
    const newAdditionalEmailsJson = newAdditionalEmailsList.length > 0 ? JSON.stringify([...new Set(newAdditionalEmailsList)]) : null;

    const transaction = db.transaction(() => {
      const attendee = db.prepare('SELECT event_id, email FROM attendees WHERE id = ?').get(attendeeId) as { event_id: number; email: string } | undefined;
      if (!attendee) {
        throw new Error('Attendee not found.');
      }
      eventIdForRedirect = attendee.event_id;

      if (newPrimaryEmail !== attendee.email) {
        const conflictingAttendee = db.prepare('SELECT id FROM attendees WHERE event_id = ? AND email = ? AND id != ?')
          .get(attendee.event_id, newPrimaryEmail, attendeeId);
        if (conflictingAttendee) {
          throw new Error('This primary email is already in use by another attendee for this event.');
        }
      }

      db.prepare('UPDATE attendees SET name = ?, email = ?, additional_emails = ?, last_modified = ? WHERE id = ?')
        .run(newName, newPrimaryEmail, newAdditionalEmailsJson, now, attendeeId);
      
      return attendee.event_id;
    });

    const finalEventId = transaction();
    res.redirect(`/admin/${finalEventId}`);

  } catch (error: any) {
    console.error('Error updating attendee details:', error.message);
    if (!eventIdForRedirect) {
      const attendeeForEventIdOnError = db.prepare('SELECT event_id FROM attendees WHERE id = ?').get(attendeeId) as {event_id: number} | undefined;
      eventIdForRedirect = attendeeForEventIdOnError?.event_id;
    }
    res.redirect(`/admin/${eventIdForRedirect || ''}?error=${encodeURIComponent(error.message || 'Failed to update attendee details.')}`);
  }
}) as any);

/**
 * Delete an attendee
 */
router.post('/attendee/:attendeeId/delete', async (req: Request, res: Response) => {
  const attendeeId = +req.params.attendeeId;
  const db = getDatabase();
  let eventIdToRedirect: number | undefined;

  try {
    const attendeeData = db.prepare('SELECT event_id FROM attendees WHERE id = ?').get(attendeeId) as { event_id: number } | undefined;
    
    if (!attendeeData) {
      console.warn(`Attempt to delete non-existent attendee ID ${attendeeId} or attendee already deleted.`);
      return res.redirect(`/admin?error=${encodeURIComponent('Attendee not found or already deleted.')}`);
    }
    eventIdToRedirect = attendeeData.event_id;

    const result = db.prepare('DELETE FROM attendees WHERE id = ?').run(attendeeId);

    if (result.changes > 0) {
      console.log(`Attendee ${attendeeId} deleted successfully.`);
    } else {
      console.warn(`No attendee found with ID ${attendeeId} to delete during delete operation.`);
    }
    res.redirect(`/admin/${eventIdToRedirect}`);

  } catch (error: any) {
    console.error(`Error deleting attendee ${attendeeId}:`, error);
    const redirectUrl = eventIdToRedirect ? `/admin/${eventIdToRedirect}` : '/admin';
    res.redirect(`${redirectUrl}?error=${encodeURIComponent('Failed to delete attendee. Check server logs.')}`);
  }
});

// ============================================================================
// Invitation Sending
// ============================================================================

/**
 * Send invitation to a single attendee
 */
router.post('/attendees/send/:attendeeId', async (req: Request, res: Response) => {
  const attendeeId = +req.params.attendeeId;
  const db = getDatabase();
  const a = db.prepare('SELECT id, name, email, token, event_id, additional_emails FROM attendees WHERE id=?')
    .get(attendeeId) as InviteeWithEventIdAndEmails | undefined;
  
  if (!a) {
    res.status(404).send('Attendee not found');
    return;
  }

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(a.event_id) as EventRecord | undefined;
  if (!event) {
    console.error(`Event not found for attendee ID ${attendeeId} with event_id ${a.event_id}`);
    res.status(404).send('Error: Associated event not found.');
    return;
  }

  const primaryEmail = a.email?.trim().toLowerCase();
  if (!primaryEmail) {
    console.warn(`Primary email missing for attendee ID ${attendeeId}. Cannot send invite.`);
    res.redirect(`/admin/${a.event_id}?error=${encodeURIComponent('Primary email missing for attendee to send invite.')}`);
    return;
  }

  let ccEmails: string[] = [];
  if (a.additional_emails) {
    try {
      const parsedAdditional = JSON.parse(a.additional_emails);
      if (Array.isArray(parsedAdditional)) {
        ccEmails = parsedAdditional
          .map(e => String(e).trim().toLowerCase())
          .filter(e => e && e !== primaryEmail);
      }
    } catch (e) {
      console.error(`Error parsing additional_emails for attendee ${a.id}:`, e);
    }
  }

  try {
    const appBaseUrl = req.app.locals.APP_BASE_URL || `http://localhost:${process.env.PORT || '3000'}`;
    await sendInvitation(a.name, primaryEmail, ccEmails, a.token, event, appBaseUrl);
    db.prepare('UPDATE attendees SET is_sent=1, last_modified=? WHERE id=?').run(Date.now(), attendeeId);
  } catch (error) {
    const errorMessage = encodeURIComponent('Failed to send invitation. Check server logs.');
    res.redirect(`/admin/${a.event_id}?error=${errorMessage}`);
    return;
  }
  
  res.redirect(`/admin/${a.event_id}`);
});

/**
 * Send all pending invitations for an event
 */
router.post('/events/:eventId/send-invites', async (req: Request, res: Response) => {
  const eventId = +req.params.eventId;
  const db = getDatabase();
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as EventRecord | undefined;
  const now = Date.now();

  if (!event) {
    console.error(`Event not found with ID ${eventId} when trying to send batch invites.`);
    res.status(404).send('Event not found.');
    return;
  }

  const pending = db.prepare('SELECT id, name, email, token, additional_emails, event_id FROM attendees WHERE event_id=? AND is_sent=0')
    .all(eventId) as InviteeWithEventIdAndEmails[];
  
  let overallSuccess = true;
  const appBaseUrl = req.app.locals.APP_BASE_URL || `http://localhost:${process.env.PORT || '3000'}`;
  
  for (const a of pending) {
    const primaryEmail = a.email?.trim().toLowerCase();
    if (!primaryEmail) {
      console.warn(`Primary email missing for attendee ID ${a.id} during batch send. Skipping.`);
      continue; 
    }

    let ccEmails: string[] = [];
    if (a.additional_emails) {
      try {
        const parsedAdditional = JSON.parse(a.additional_emails);
        if (Array.isArray(parsedAdditional)) {
          ccEmails = parsedAdditional
            .map(e => String(e).trim().toLowerCase())
            .filter(e => e && e !== primaryEmail);
        }
      } catch (e) {
        console.error(`Error parsing additional_emails for attendee ${a.id} during batch send:`, e);
      }
    }
    
    try {
      await sendInvitation(a.name, primaryEmail, ccEmails, a.token, event, appBaseUrl);
      db.prepare('UPDATE attendees SET is_sent=1, last_modified=? WHERE id=?').run(now, a.id);
    } catch (sendError) {
      overallSuccess = false;
      console.error(`Failed to send batch invite for attendee ${a.id} (To: ${primaryEmail}, CC: ${ccEmails.join(', ')}). Continuing with others.`);
    }
  }

  if (!overallSuccess) {
    const errorMessage = encodeURIComponent('Some invitations could not be sent. Please check server logs for details.');
    res.redirect(`/admin/${eventId}?error=${errorMessage}`);
  } else {
    res.redirect(`/admin/${eventId}`);
  }
});

export default router;
