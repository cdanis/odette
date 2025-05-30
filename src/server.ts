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
import multer from 'multer'; // For file uploads
import fs from 'fs'; // For file system operations (e.g., deleting old banners, creating dirs)

// Config loader (e.g. dotenv)
// import dotenv from 'dotenv'; dotenv.config();

export const PORT = process.env.PORT ?? '3000';
export const APP_BASE_URL = process.env.APP_BASE_URL ?? `http://localhost:${PORT}`;
const DB_PATH = process.env.DB_PATH ?? './rsvp.sqlite'; // Default for local, overridden by Docker ENV
const EVENT_BANNER_STORAGE_PATH = process.env.EVENT_BANNER_STORAGE_PATH || './data/uploads/event-banners'; // For uploaded banners

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
// When running compiled code from dist/, __dirname is dist/src, so ../views is <project_root>/views
app.set('views', path.join(__dirname, '../views'));
app.use(bodyParser.urlencoded({ extended: true })); // For form data

// Static serving for bundled public assets (CSS, etc.)
// Resolves to <project_root>/dist/public when running compiled code
app.use('/static', express.static(path.join(__dirname, '../public')));

// Static serving for uploaded event banners from the configured storage path
// EVENT_BANNER_STORAGE_PATH is an absolute path like /data/uploads/event-banners
console.log(`Serving event banners from: ${EVENT_BANNER_STORAGE_PATH}`);
app.use('/uploads/event-banners', express.static(EVENT_BANNER_STORAGE_PATH));
// Ensure the directory for banner uploads exists
try {
    fs.mkdirSync(EVENT_BANNER_STORAGE_PATH, { recursive: true });
    console.log(`Upload directory ${EVENT_BANNER_STORAGE_PATH} is ready.`);
} catch (err) {
    console.error(`Error creating upload directory ${EVENT_BANNER_STORAGE_PATH}:`, err);
}


// Session middleware
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false, 
  // cookie: { secure: process.env.NODE_ENV === 'production' } 
}));

// CSRF protection middleware instance
const csrfProtection = csurf();


export const db = new Database.default(DB_PATH);
db.prepare(`CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  date INTEGER NOT NULL,
  description TEXT,
  banner_image_filename TEXT,
  location_name TEXT,
  location_href TEXT,
  date_end INTEGER
)`).run();

const columnsToAdd = [
    { name: 'banner_image_filename', type: 'TEXT' },
    { name: 'location_name', type: 'TEXT' },
    { name: 'location_href', type: 'TEXT' },
    { name: 'date_end', type: 'INTEGER' }
];

columnsToAdd.forEach(col => {
    try {
        db.prepare(`SELECT ${col.name} FROM events LIMIT 1`).get();
    } catch (error) {
        // Column likely doesn't exist, try to add it
        console.log(`Attempting to add ${col.name} column to events table...`);
        try {
            db.prepare(`ALTER TABLE events ADD COLUMN ${col.name} ${col.type}`).run();
            console.log(`Column ${col.name} added successfully.`);
        } catch (alterError) {
            console.error(`Failed to add ${col.name} column:`, alterError);
        }
    }
});


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
  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
)`).run(); 

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, EVENT_BANNER_STORAGE_PATH); // Use the absolute path from environment or default
  },
  filename: function (req, file, cb) {
    const eventIdPart = req.params.eventId || 'temp'; 
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `event-${eventIdPart}-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png' || file.mimetype === 'image/gif') {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG, and GIF are allowed.'));
  }
};

const upload = multer({ 
    storage: storage, 
    fileFilter: fileFilter, 
    limits: { fileSize: 5 * 1024 * 1024 } 
});


export function generateToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

// Helper function to format JS timestamp to ICS UTC date-time string
function formatICSDate(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (num: number) => num.toString().padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

// Helper function to escape text for ICS content
function escapeICSText(text: string | null | undefined): string {
  if (!text) return '';
  // Escape backslashes first, then other characters
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

export async function sendInvitation(name: string, email: string, token: string, eventTitle: string) {
  const link = `${APP_BASE_URL}/rsvp/${token}`;
  const html = `<p>Hi ${name},</p>\n<p>You are invited to ${eventTitle}.</p>\n<p>Please RSVP here: <a href=\"${link}\">${link}</a></p>`;
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
  const finalPartySize = party_size === undefined || isNaN(party_size) || party_size < 1 ? 1 : party_size;

  if (existing) {
    const rsvpStatus = db.prepare('SELECT rsvp FROM attendees WHERE id = ?').get(existing.id) as { rsvp: string | null } | undefined;
    if (rsvpStatus && rsvpStatus.rsvp === null) {
        if (party_size !== undefined && existing.party_size !== finalPartySize) {
            db.prepare('UPDATE attendees SET party_size=? WHERE id=?')
              .run(finalPartySize, existing.id);
        }
    }
  } else {
    const token = generateToken();
    db.prepare('INSERT INTO attendees (event_id,name,email,party_size,token) VALUES (?,?,?,?,?)')
      .run(event_id, name, email, finalPartySize, token);
  }
}

type EventRecord = { 
  id: number; 
  title: string; 
  date: number; 
  description: string | null; 
  banner_image_filename?: string | null; 
  location_name?: string | null;
  location_href?: string | null;
  date_end?: number | null;
};
type AttendeeView = { 
  id:number; 
  event_id:number; 
  name:string; 
  email:string; 
  party_size:number; 
  is_sent:number; 
  rsvp:string|null; 
  responded_at:number|null; 
  event_title:string; 
  event_date:number; 
  event_desc:string | null; 
  token: string; 
  event_banner_image_filename?: string | null; 
  event_location_name?: string | null;
  event_location_href?: string | null;
  event_date_end?: number | null;
};
type EventAttendeeView = { 
  id:number; 
  event_id:number; 
  name:string; 
  email:string; 
  party_size:number; 
  token: string; 
  is_sent:number; 
  rsvp:string|null; 
  responded_at:number|null; 
};

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

app.get('/admin', csrfProtection, (req, res) => {
  const eventsRaw = db.prepare('SELECT * FROM events ORDER BY date').all() as EventRecord[];
  const events: EventRecordWithStats[] = eventsRaw.map(event => ({
    ...event,
    stats: getEventAttendeeStats(event.id)
  }));
  res.render('admin', { events, csrfToken: req.csrfToken() });
});

app.get('/admin/:eventId', csrfProtection, (req, res) => {
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

  res.render('event-admin', { event, attendees, allEvents, attendeeStats, csrfToken: req.csrfToken() });
});

app.post('/admin/event', upload.single('banner_image'), csrfProtection, (req, res) => {
  const { title, date, description, location_name, location_href, date_end } = req.body;
  const dateTimestamp = new Date(date).getTime();
  let dateEndTimestamp: number | null = null;
  if (date_end) {
    const parsedEnd = new Date(date_end).getTime();
    if (!isNaN(parsedEnd)) {
        dateEndTimestamp = parsedEnd;
    }
  }
  
  const result = db.prepare(
    'INSERT INTO events (title, date, description, banner_image_filename, location_name, location_href, date_end) VALUES (?,?,?,?,?,?,?)'
    ).run(title, dateTimestamp, description, null, location_name || null, location_href || null, dateEndTimestamp);
  
  const eventId = result.lastInsertRowid;

  if (req.file && eventId) {
    const tempMulterFilename = req.file.filename; 
    const finalFilename = `event-${eventId}-${Date.now()}${path.extname(req.file.originalname)}`;
    
    const oldPath = path.join(EVENT_BANNER_STORAGE_PATH, tempMulterFilename);
    const newPath = path.join(EVENT_BANNER_STORAGE_PATH, finalFilename);

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

app.post('/admin/event/:eventId/update', upload.single('banner_image'), csrfProtection, (req, res) => {
  const eventId = +req.params.eventId;
  const { title, date, description, location_name, location_href, date_end } = req.body;
  const dateTimestamp = new Date(date).getTime();
  let dateEndTimestamp: number | null = null;
  if (date_end) {
    const parsedEnd = new Date(date_end).getTime();
    if (!isNaN(parsedEnd)) {
        dateEndTimestamp = parsedEnd;
    }
  }

  const currentEventData = db.prepare('SELECT banner_image_filename FROM events WHERE id = ?').get(eventId) as { banner_image_filename?: string | null };

  if (req.file) {
    const newBannerFilename = req.file.filename; 
    if (currentEventData && currentEventData.banner_image_filename) {
      const oldBannerPath = path.join(EVENT_BANNER_STORAGE_PATH, currentEventData.banner_image_filename);
      fs.unlink(oldBannerPath, (err) => {
        if (err && err.code !== 'ENOENT') { 
             console.error(`Failed to delete old banner image ${oldBannerPath}:`, err);
        } else if (!err) {
            console.log(`Deleted old banner image ${oldBannerPath}`);
        }
      });
    }
    db.prepare(
        'UPDATE events SET title = ?, date = ?, description = ?, banner_image_filename = ?, location_name = ?, location_href = ?, date_end = ? WHERE id = ?'
        ).run(title, dateTimestamp, description, newBannerFilename, location_name || null, location_href || null, dateEndTimestamp, eventId);
  } else {
    db.prepare(
        'UPDATE events SET title = ?, date = ?, description = ?, location_name = ?, location_href = ?, date_end = ? WHERE id = ?'
        ).run(title, dateTimestamp, description, location_name || null, location_href || null, dateEndTimestamp, eventId);
  }
  res.redirect(`/admin/${eventId}`);
});

app.post('/admin/attendee', csrfProtection, (req, res) => {
  const eventId = +req.body.event_id;
  const partySize = parseInt(req.body.party_size, 10);
  upsertAttendee(eventId, req.body.name, req.body.email, isNaN(partySize) || partySize < 1 ? 1 : partySize);
  res.redirect(`/admin/${eventId}`);
});

app.post('/admin/attendees/batch', csrfProtection, (req, res) => {
  const eventId = +req.body.event_id;
  req.body.csv.split(/\r?\n/).forEach((line: string) => {
    const [name, email, partyStr] = line.split(',').map((s: string) => s.trim());
    if (name && email) {
      const party = parseInt(partyStr, 10);
      upsertAttendee(eventId, name, email, isNaN(party) || party < 1 ? 1 : party);
    }
  });
  res.redirect(`/admin/${eventId}`);
});

app.post('/admin/event/:eventId/attendees/parse-emails', csrfProtection, (req, res) => {
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
        upsertAttendee(eventId, name, email); 
      }
    });
  } catch (error) {
    console.error("Error parsing email field data:", error);
  }

  res.redirect(`/admin/${eventId}`);
});

app.post('/admin/attendees/copy', csrfProtection, (req, res) => {
  const fromEventId = +req.body.from_event;
  const toEventId = +req.body.to_event;
  const rows = db.prepare('SELECT name,email,party_size FROM attendees WHERE event_id=?').all(fromEventId) as {name: string, email: string, party_size: number}[];
  rows.forEach((r) => upsertAttendee(toEventId, r.name, r.email, r.party_size));
  res.redirect(`/admin/${toEventId}`);
});

interface InviteeWithEventId extends Invitee { event_id: number; }
interface Invitee { id: number; name: string; email: string; token: string; }

app.post('/admin/attendees/send/:attendeeId', csrfProtection, async (req, res) => {
  const attendeeId = +req.params.attendeeId;
  const a = db.prepare('SELECT id, name, email, token, event_id FROM attendees WHERE id=?').get(attendeeId) as InviteeWithEventId | undefined;
  if (a) {
    const event = db.prepare('SELECT title FROM events WHERE id = ?').get(a.event_id) as { title: string } | undefined;
    if (!event) {
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

app.post('/admin/events/:eventId/send-invites', csrfProtection, async (req, res) => {
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

app.post('/admin/attendee/:attendeeId/update-party-size', csrfProtection, (req, res) => {
  const attendeeId = +req.params.attendeeId;
  const newPartySize = parseInt(req.body.party_size, 10);

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

  const result = db.prepare('UPDATE attendees SET party_size = ? WHERE id = ? AND rsvp IS NULL')
                   .run(newPartySize, attendeeId);

  if (result.changes === 0 && attendeeInfo.rsvp === null) {
    console.warn(`Party size update for attendee ${attendeeId} (who had no RSVP) did not result in changes. Current DB rsvp: ${attendeeInfo.rsvp}. Submitted party size: ${newPartySize}.`);
  } else if (result.changes > 0) {
    console.log(`Party size updated for attendee ${attendeeId} to ${newPartySize}.`);
  }
  
  res.redirect(`/admin/${attendeeInfo.event_id}`);
});


app.get('/user/:id', (req, res) => { 
    res.send(`user ${req.params.id}`)
  });


app.get('/rsvp/:tok', csrfProtection, (req, res) => {
        if (!/^[0-9a-f]{32}$/.test(req.params.tok)) {
            res.status(400).send('Invalid token format');
            return;
        }
        const attendee = db.prepare(
            `SELECT a.*, 
                    e.title AS event_title, 
                    e.date as event_date, 
                    e.description as event_desc,
                    e.banner_image_filename AS event_banner_image_filename,
                    e.location_name AS event_location_name,
                    e.location_href AS event_location_href,
                    e.date_end AS event_date_end
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

app.post('/rsvp/:token', csrfProtection, async (req, res) => {
    if (!/^[0-9a-f]{32}$/.test(req.params.token)) {
        res.status(400).send('Invalid token format');
        return;
    }
    const { rsvp, party_size: partySizeStr } = req.body;
    const now = Date.now();
    
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

    db.prepare('UPDATE attendees SET rsvp=?, party_size=?, responded_at=? WHERE token=?')
        .run(rsvp, finalPartySize, now, req.params.token);
    
    await notifyAdmin(attendeeData, rsvp, (rsvp === 'yes' ? finalPartySize : 0));
    
    res.render('thanks', { rsvp, party_size: (rsvp === 'yes' ? finalPartySize : 0) });
});

// Route for ICS file download
app.get('/ics/:token', async (req, res) => {
  if (!/^[0-9a-f]{32}$/.test(req.params.token)) {
    res.status(400).send('Invalid token format');
    return;
  }

  const eventDataForICS = db.prepare(
    `SELECT e.id AS event_id,
            e.title AS event_title, 
            e.date AS event_date, 
            e.description AS event_desc,
            e.location_name AS event_location_name,
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
    event_date_end 
  } = eventDataForICS;

  const now = Date.now();
  const dtstamp = formatICSDate(now);
  const dtstart = formatICSDate(event_date);
  
  // Extract domain from APP_BASE_URL for UID
  const domain = APP_BASE_URL.replace(/^https?:\/\//, '').split('/')[0];

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

  if (event_desc) {
    icsContent.push(`DESCRIPTION:${escapeICSText(event_desc)}`);
  }
  if (event_location_name) {
    icsContent.push(`LOCATION:${escapeICSText(event_location_name)}`);
  }
  
  icsContent.push('END:VEVENT');
  icsContent.push('END:VCALENDAR');

  const filenameSafeTitle = (event_title || 'event').replace(/[^a-z0-9_.-]/gi, '_').substring(0, 50);
  
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameSafeTitle}.ics"`);
  res.send(icsContent.join('\r\n')); // ICS spec requires CRLF line endings
});


app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof multer.MulterError) {
    console.error('Multer Error:', err.message); 
    const redirectUrl = req.headers.referer || (req.body.event_id ? `/admin/${req.body.event_id}` : (req.params.eventId ? `/admin/${req.params.eventId}` : '/admin'));
    return res.redirect(`${redirectUrl}?error=${encodeURIComponent(err.message)}`);
  } else if (err && (err.message.includes('Invalid file type') || err.message.includes('File too large'))) { 
    console.error('File Upload Error:', err.message);
    const redirectUrl = req.headers.referer || (req.body.event_id ? `/admin/${req.body.event_id}` : (req.params.eventId ? `/admin/${req.params.eventId}` : '/admin'));
    return res.redirect(`${redirectUrl}?error=${encodeURIComponent(err.message)}`);
  }
  next(err); 
});


app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err.code === 'EBADCSRFTOKEN') {
    console.error('CSRF Token Error:', err);
    let userMessage = 'Form tampered with or session expired. Please refresh the page and try again.';
    let backLink = req.headers.referer || '/admin'; 

    if (req.originalUrl.startsWith('/admin')) {
        userMessage = 'Admin form submission error (CSRF): Form tampered with or session expired. Please refresh and try again.';
        backLink = req.originalUrl.split('?')[0]; 
         if (!req.originalUrl.includes('/admin/event/')) { 
            backLink = '/admin';
         }
    } else if (req.originalUrl.startsWith('/rsvp')) {
        userMessage = 'RSVP submission error (CSRF): Form submission issue or session expired. Please try using your unique link again. If the problem persists, contact the event organizer.';
        backLink = '/'; 
    }
    res.status(403).send(`${userMessage} <a href="${backLink}">Go back</a>`);
  } else {
    next(err); 
  }
});
