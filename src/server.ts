// src/server.ts

// Copyright (C) 2025  Chris Danis
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
import express from 'express';
import * as path from 'path';
import * as bodyParser from 'body-parser';
import * as nodemailer from 'nodemailer';
import * as Database from 'better-sqlite3';
import * as crypto from 'crypto';
import session from 'express-session';
import csurf from 'csurf';
import addressparser from 'addressparser'; // Added for email parsing feature

// Config loader (e.g. dotenv)
// import dotenv from 'dotenv'; dotenv.config();

export const PORT = process.env.PORT ?? '3000';
export const APP_BASE_URL = process.env.APP_BASE_URL ?? `http://localhost:${PORT}`;
const DB_PATH = process.env.DB_PATH ?? './rsvp.sqlite';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const NTFY_BASE_URL = (process.env.NTFY_BASE_URL ?? 'https://ntfy.sh').replace(/\/+$/, '');
const NTFY_USER = process.env.NTFY_USER;
const NTFY_PASS = process.env.NTFY_PASS;
// IMPORTANT: Use a strong, random secret from environment variables in production
const SESSION_SECRET = process.env.SESSION_SECRET || 'your-super-secret-and-long-random-string';


export const app = express();
app.set('view engine', 'ejs');
// Assuming 'views' directory is at the project root, sibling to 'src' and 'dist'
app.set('views', path.join(__dirname, '../views'));
app.use(bodyParser.urlencoded({ extended: true }));
// Assuming 'public' directory is copied to 'dist/public' during build
app.use('/static', express.static(path.join(__dirname, 'public')));

// Session middleware
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false, // Set to true if you want to store session for all users, false for GDPR compliance until login/consent
  // cookie: { secure: process.env.NODE_ENV === 'production' } // Use secure cookies in production (requires HTTPS)
}));

// CSRF protection middleware
// Note: csurf must be after session middleware and body-parser
const csrfProtection = csurf();
app.use(csrfProtection);

// Middleware to make CSRF token available to all views (optional, but convenient)
// Or pass it explicitly in each route handler
app.use((req, res, next) => {
  res.locals.csrfToken = req.csrfToken();
  next();
});


export const db = new Database.default(DB_PATH);
db.prepare(`CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  date INTEGER NOT NULL,
  description TEXT
)`).run();
db.prepare(`CREATE TABLE IF NOT EXISTS attendees (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  party_size INTEGER NOT NULL DEFAULT 1,
  token TEXT NOT NULL UNIQUE,
  is_sent INTEGER NOT NULL DEFAULT 0,
  rsvp TEXT DEFAULT NULL,
  responded_at INTEGER DEFAULT NULL,
  FOREIGN KEY(event_id) REFERENCES events(id)
)`).run();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});

export function generateToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

export async function sendInvitation(name: string, email: string, token: string, eventTitle: string) {
  const link = `${APP_BASE_URL}/rsvp/${token}`;
  const html = `<p>Hi ${name},</p>\n<p>Please RSVP here: <a href=\"${link}\">${link}</a></p>`;
  const subject = `Please RSVP for ${eventTitle}`;
  await console.log(`Sending invite to ${email}`, { from: SMTP_USER, to: email, subject, html });
  if (SMTP_USER && SMTP_PASS) {
    await transporter.sendMail({ from: SMTP_USER, to: email, subject, html });
  }
}

export async function notifyAdmin(att: any, rsvp: string, partySize: number) {
  if (!NTFY_TOPIC) return;
  const title = `RSVP: ${att.name}`;
  const msg = `Event: ${att.event_title}\nResponse: ${rsvp}\nParty Size: ${partySize}`;
  const headers: Record<string,string> = { 'Title': title };
  if (NTFY_USER && NTFY_PASS) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${NTFY_USER}:${NTFY_PASS}`).toString('base64');
  }
  try {
    await fetch(`${NTFY_BASE_URL}/${NTFY_TOPIC}`, { method: 'POST', headers, body: msg });
  } catch (e) {
    console.error('ntfy error', e);
  }
}

interface ExistingAttendee { id: number; party_size: number; }

export function upsertAttendee(event_id: number, name: string, email: string, party_size?: number) {
  const stmtSelect = db.prepare('SELECT id, party_size FROM attendees WHERE event_id=? AND email=?');
  const existing = stmtSelect.get(event_id, email) as ExistingAttendee | undefined;
  if (existing) {
    // Only update party_size if no RSVP has been submitted yet for this existing attendee
    const rsvpStatus = db.prepare('SELECT rsvp FROM attendees WHERE id = ?').get(existing.id) as { rsvp: string | null } | undefined;
    if (rsvpStatus && rsvpStatus.rsvp === null) { // Check if RSVP is null (no response yet)
        if (party_size && existing.party_size !== party_size) { // And if party size actually needs or wants updating
            db.prepare('UPDATE attendees SET party_size=? WHERE id=?')
              .run(party_size, existing.id);
        }
    } // If rsvpStatus is not null OR rsvp is not null (i.e., a response exists), do nothing to party_size here.
      // This prevents batch add/copy from overwriting party sizes of already responded guests.
  } else {
    const token = generateToken();
    db.prepare('INSERT INTO attendees (event_id,name,email,party_size,token) VALUES (?,?,?,?,?)')
      .run(event_id, name, email, party_size || 1, token);
  }
}

type EventRecord = { id: number; title: string; date: number; description: string | null; };
type AttendeeView = { id:number; event_id:number; name:string; email:string; party_size:number; is_sent:number; rsvp:string|null; responded_at:number|null; event_title:string; event_date:number; event_desc:string; token: string; };
type EventAttendeeView = { id:number; event_id:number; name:string; email:string; party_size:number; token: string; is_sent:number; rsvp:string|null; responded_at:number|null; };

interface AttendeeStats {
  potentialGuests: number;
  guestsNotSent: number;
  guestsInvited: number;
  guestsAwaitingReply: number;
  guestsAttending: number;
  guestsNotAttending: number;
}

function getEventAttendeeStats(eventId: number): AttendeeStats {
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

type EventRecordWithStats = EventRecord & { stats: AttendeeStats };

app.get('/admin', (req, res) => {
  const eventsRaw = db.prepare('SELECT * FROM events ORDER BY date').all() as EventRecord[];
  const events: EventRecordWithStats[] = eventsRaw.map(event => ({
    ...event,
    stats: getEventAttendeeStats(event.id)
  }));
  // csrfToken is available via res.locals.csrfToken due to the middleware
  res.render('admin', { events });
});

app.get('/admin/:eventId', (req, res) => {
  const eventId = +req.params.eventId;
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as EventRecord | undefined;
  if (!event) {
    res.status(404).send('Event not found');
    return;
  }
  const attendees = db.prepare(
    'SELECT id, event_id, name, email, party_size, token, is_sent, rsvp, responded_at FROM attendees WHERE event_id = ? ORDER BY name'
  ).all(eventId) as EventAttendeeView[];
  const allEvents = db.prepare('SELECT id, title FROM events WHERE id != ? ORDER BY title').all(eventId) as {id: number, title: string}[];
  const attendeeStats = getEventAttendeeStats(eventId);

  // csrfToken is available via res.locals.csrfToken
  res.render('event-admin', { event, attendees, allEvents, attendeeStats });
});

app.post('/admin/event', (req, res) => {
  db.prepare('INSERT INTO events (title,date,description) VALUES (?,?,?)')
    .run(req.body.title, new Date(req.body.date).getTime(), req.body.description);
  res.redirect('/admin');
});

app.post('/admin/event/:eventId/update', (req, res) => {
  const eventId = +req.params.eventId;
  const { title, date, description } = req.body;
  const dateTimestamp = new Date(date).getTime();
  db.prepare('UPDATE events SET title = ?, date = ?, description = ? WHERE id = ?')
    .run(title, dateTimestamp, description, eventId);
  res.redirect(`/admin/${eventId}`);
});

app.post('/admin/attendee', (req, res) => {
  const eventId = +req.body.event_id;
  upsertAttendee(eventId, req.body.name, req.body.email, req.body.party_size);
  res.redirect(`/admin/${eventId}`);
});

// FIXME: this isn't a real CSV parser; names are likely to contain commas!
// todo: rethink this feature
app.post('/admin/attendees/batch', (req, res) => {
  const eventId = +req.body.event_id;
  req.body.csv.split(/\r?\n/).forEach((line: string) => {
    const [name, email, party] = line.split(',').map((s: string) => s.trim());
    if (name && email) upsertAttendee(eventId, name, email, (party||null));
  });
  res.redirect(`/admin/${eventId}`);
});

app.post('/admin/event/:eventId/attendees/parse-emails', (req, res) => {
  const eventId = +req.params.eventId;
  const emailFieldData = req.body.email_field_data as string;

  if (!emailFieldData) {
    // Optionally: add a flash message for empty input
    return res.redirect(`/admin/${eventId}`);
  }

  try {
    const parsedAddresses = addressparser(emailFieldData);
    parsedAddresses.forEach(parsed => {
      if (parsed.address) { // Ensure there's an email address
        const email = parsed.address;
        // Use provided name, or fallback to local part of email if name is empty
        const name = parsed.name || email.substring(0, email.lastIndexOf('@')).replace(/[."']/g, ' ').trim();
        upsertAttendee(eventId, name, email);
      }
    });
  } catch (error) {
    console.error("Error parsing email field data:", error);
    // Optionally: add a flash message to inform the user of an error
  }

  res.redirect(`/admin/${eventId}`);
});

app.post('/admin/attendees/copy', (req, res) => {
  const fromEventId = +req.body.from_event;
  const toEventId = +req.body.to_event;
  const rows = db.prepare('SELECT name,email,party_size FROM attendees WHERE event_id=?').all(fromEventId);
  rows.forEach((r: any) => upsertAttendee(toEventId, r.name, r.email, r.party_size));
  res.redirect(`/admin/${toEventId}`);
});

interface InviteeWithEventId extends Invitee { event_id: number; }
interface Invitee { id: number; name: string; email: string; token: string; }

app.post('/admin/attendees/send/:attendeeId', async (req, res) => {
  const attendeeId = +req.params.attendeeId;
  const a = db.prepare('SELECT id, name, email, token, event_id FROM attendees WHERE id=?').get(attendeeId) as InviteeWithEventId | undefined;
  if (a) {
    const event = db.prepare('SELECT title FROM events WHERE id = ?').get(a.event_id) as { title: string } | undefined;
    if (!event) {
        // This case should ideally not happen if data integrity is maintained
        console.error(`Event not found for attendee ID ${attendeeId} with event_id ${a.event_id}`);
        res.status(404).send('Error: Associated event not found.');
        return;
    }
    await sendInvitation(a.name, a.email, a.token, event.title);
    db.prepare('UPDATE attendees SET is_sent=1 WHERE id=?').run(attendeeId);
    res.redirect(`/admin/${a.event_id}`);
  } else {
    res.status(404).send('Attendee not found');
  }
});

app.post('/admin/events/:eventId/send-invites', async (req, res) => {
  const eventId = +req.params.eventId;
  const event = db.prepare('SELECT title FROM events WHERE id = ?').get(eventId) as { title: string } | undefined;

  if (!event) {
    console.error(`Event not found with ID ${eventId} when trying to send batch invites.`);
    res.status(404).send('Event not found.');
    return;
  }

  const pending = db.prepare('SELECT id,name,email,token FROM attendees WHERE event_id=? AND is_sent=0').all(eventId) as Invitee[];
  for (const a of pending) {
    await sendInvitation(a.name, a.email, a.token, event.title);
    db.prepare('UPDATE attendees SET is_sent=1 WHERE id=?').run(a.id);
  }
  res.redirect(`/admin/${eventId}`);
});

app.post('/admin/attendee/:attendeeId/update-party-size', (req, res) => {
  const attendeeId = +req.params.attendeeId;
  const newPartySize = parseInt(req.body.party_size, 10);

  const attendeeInfo = db.prepare('SELECT event_id, rsvp FROM attendees WHERE id = ?')
                         .get(attendeeId) as { event_id: number; rsvp: string | null } | undefined;

  if (!attendeeInfo) {
    // Optionally: add a flash message for "attendee not found"
    console.warn(`Attempt to update party size for non-existent attendee ID ${attendeeId}`);
    res.status(404).send('Attendee not found.'); // Or redirect to a generic admin error page
    return;
  }

  // Validate party size input
  if (isNaN(newPartySize) || newPartySize < 1) {
    // Optionally: add a flash message for "invalid party size"
    console.warn(`Invalid party size submitted for attendee ${attendeeId}: ${req.body.party_size}. Redirecting.`);
    res.redirect(`/admin/${attendeeInfo.event_id}`); // Redirect back, maybe with an error query param or flash message
    return;
  }

  // Crucial check: only update if RSVP has not been submitted
  if (attendeeInfo.rsvp !== null) {
    // Optionally: add a flash message indicating why the update was not performed
    console.warn(`Attempt to update party size for attendee ${attendeeId} who has already RSVP'd. No update performed. Redirecting.`);
    res.redirect(`/admin/${attendeeInfo.event_id}`);
    return ;
  }

  // Perform the update only if rsvp is NULL
  const result = db.prepare('UPDATE attendees SET party_size = ? WHERE id = ? AND rsvp IS NULL')
                   .run(newPartySize, attendeeId);

  if (result.changes === 0 && attendeeInfo.rsvp === null) {
    // This could happen if, between page load and form submission, the attendee RSVP'd through another means,
    // or if the party size submitted was the same as the existing one (though the form should prefill).
    // Or, more likely, if the rsvp status changed just before the update.
    console.warn(`Party size update for attendee ${attendeeId} (who had no RSVP) did not result in changes. Current DB rsvp: ${attendeeInfo.rsvp}. Submitted party size: ${newPartySize}.`);
    // Optionally: add a flash message
  } else if (result.changes > 0) {
    // Optionally: add a success flash message
    console.log(`Party size updated for attendee ${attendeeId} to ${newPartySize}.`);
  }
  
  res.redirect(`/admin/${attendeeInfo.event_id}`);
});


app.get('/user/:id', (req, res) => {
    res.send(`user ${req.params.id}`)
  });


app.get('/rsvp/:tok', (req, res) => {
        if (!/^[0-9a-f]{32}$/.test(req.params.tok)) {
            res.status(400).send('Invalid token format');
            return;
        }
        const attendee = db.prepare(
            'SELECT a.*,e.title AS event_title,e.date as event_date,e.description as event_desc FROM attendees a JOIN events e ON a.event_id=e.id WHERE a.token=?'
        ).get(req.params.tok) as AttendeeView;
        if (!attendee) {
            res.status(404).send('Invalid link');
            return;
        }
        // csrfToken is available via res.locals.csrfToken
        res.render('rsvp', { attendee });
});

app.post('/rsvp/:token', async (req, res) => {
    if (!/^[0-9a-f]{32}$/.test(req.params.token)) {
        res.status(400).send('Invalid token format');
        return;
    }
        const { rsvp, party_size } = req.body;
        const now = Date.now();
        const a = db.prepare(
            'SELECT a.name, a.token, e.title AS event_title FROM attendees a JOIN events e ON a.event_id=e.id WHERE a.token=?'
        ).get(req.params.token) as { name: string; token: string; event_title: string };

        if (!a) {
            res.status(404).send('Invalid token or attendee not found.');
            return;
        }

        db.prepare('UPDATE attendees SET rsvp=?,party_size=?,responded_at=? WHERE token=?')
            .run(rsvp, +party_size, now, req.params.token);
        await notifyAdmin(a, rsvp, +party_size);
        // csrfToken is available via res.locals.csrfToken for the thanks page if it had forms
        res.render('thanks', { rsvp, party_size });
    }
);

// CSRF Error Handler
// This must be defined after all routes that use CSRF protection
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err.code === 'EBADCSRFTOKEN') {
    console.error('CSRF Token Error:', err);
    res.status(403).send('Form tampered with or session expired - please try again.');
  } else {
    next(err);
  }
});
