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
app.use(bodyParser.urlencoded({ extended: true })); // For form data
// app.use(bodyParser.json()); // If you need to parse JSON bodies

// Assuming 'public' directory is copied to 'dist/public' during build
// This will serve files from 'dist/public' under '/static' URL path
app.use('/static', express.static(path.join(__dirname, '../public')));


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
// We will apply csrfProtection selectively or globally after multer potentially
// For now, let's apply it globally and see how it interacts with file uploads.
// Multer processes multipart forms before CSRF, so req.body might not be populated for CSRF token check
// if multer is used on the same route. A common pattern is to have multer process first.
// The order here is: bodyParser, session, then csrf.
// If a route uses multer, multer should be middleware before the main handler.

app.use(csrfProtection); // Apply CSRF globally

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
  description TEXT,
  banner_image_filename TEXT
)`).run();

// Attempt to add banner_image_filename column if it doesn't exist (for existing setups)
try {
    db.prepare('SELECT banner_image_filename FROM events LIMIT 1').get();
} catch (error) {
    console.log('Attempting to add banner_image_filename column to events table...');
    try {
        db.prepare('ALTER TABLE events ADD COLUMN banner_image_filename TEXT').run();
        console.log('Column banner_image_filename added successfully.');
    } catch (alterError) {
        console.error('Failed to add banner_image_filename column:', alterError);
    }
}


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
)`).run(); // Added ON DELETE CASCADE for attendees when event is deleted

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});

// Multer setup for file uploads
const uploadDir = path.join(__dirname, '../public/uploads/event-banners');
// Ensure upload directory exists
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Filename: event-<eventId>-<timestamp>.<ext>
    // If eventId is not yet available (e.g. new event), use a temporary name
    const eventId = req.params.eventId || 'temp';
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `event-${eventId}-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png' || file.mimetype === 'image/gif') {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG, and GIF are allowed.'));
  }
};

const upload = multer({ storage: storage, fileFilter: fileFilter, limits: { fileSize: 5 * 1024 * 1024 } }); // Limit file size to 5MB


export function generateToken(): string {
  return crypto.randomBytes(16).toString('hex');
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
        // Only update party_size if a party_size was explicitly provided and it's different
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

type EventRecord = { id: number; title: string; date: number; description: string | null; banner_image_filename?: string | null; };
type AttendeeView = { id:number; event_id:number; name:string; email:string; party_size:number; is_sent:number; rsvp:string|null; responded_at:number|null; event_title:string; event_date:number; event_desc:string | null; token: string; event_banner_image_filename?: string | null; };
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

  res.render('event-admin', { event, attendees, allEvents, attendeeStats });
});

app.post('/admin/event', upload.single('banner_image'), (req, res) => {
  const { title, date, description } = req.body;
  const dateTimestamp = new Date(date).getTime();
  
  const result = db.prepare('INSERT INTO events (title,date,description, banner_image_filename) VALUES (?,?,?,?)')
    .run(title, dateTimestamp, description, null); // Insert null for filename initially
  
  const eventId = result.lastInsertRowid;

  if (req.file && eventId) {
    const tempFilename = req.file.filename;
    const finalFilename = `event-${eventId}-${Date.now()}${path.extname(req.file.originalname)}`;
    const oldPath = path.join(uploadDir, tempFilename);
    const newPath = path.join(uploadDir, finalFilename);

    fs.rename(oldPath, newPath, (err) => {
      if (err) {
        console.error("Error renaming uploaded file:", err);
        // Keep the event, but banner won't be linked. Or handle error more gracefully.
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

app.post('/admin/event/:eventId/update', upload.single('banner_image'), (req, res) => {
  const eventId = +req.params.eventId;
  const { title, date, description } = req.body;
  const dateTimestamp = new Date(date).getTime();

  let newBannerFilename: string | null = null;

  if (req.file) {
    newBannerFilename = req.file.filename;
    // Fetch old banner filename to delete it
    const oldEventData = db.prepare('SELECT banner_image_filename FROM events WHERE id = ?').get(eventId) as { banner_image_filename?: string | null };
    if (oldEventData && oldEventData.banner_image_filename) {
      const oldBannerPath = path.join(uploadDir, oldEventData.banner_image_filename);
      fs.unlink(oldBannerPath, (err) => {
        if (err) console.error(`Failed to delete old banner image ${oldBannerPath}:`, err);
        else console.log(`Deleted old banner image ${oldBannerPath}`);
      });
    }
    db.prepare('UPDATE events SET title = ?, date = ?, description = ?, banner_image_filename = ? WHERE id = ?')
      .run(title, dateTimestamp, description, newBannerFilename, eventId);
  } else {
    // No new file uploaded, just update other fields
    db.prepare('UPDATE events SET title = ?, date = ?, description = ? WHERE id = ?')
      .run(title, dateTimestamp, description, eventId);
  }
  res.redirect(`/admin/${eventId}`);
});

app.post('/admin/attendee', (req, res) => {
  const eventId = +req.body.event_id;
  // Ensure party_size is a number, default to 1 if invalid or not provided
  const partySize = parseInt(req.body.party_size, 10);
  upsertAttendee(eventId, req.body.name, req.body.email, isNaN(partySize) || partySize < 1 ? 1 : partySize);
  res.redirect(`/admin/${eventId}`);
});

app.post('/admin/attendees/batch', (req, res) => {
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

app.post('/admin/event/:eventId/attendees/parse-emails', (req, res) => {
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
        upsertAttendee(eventId, name, email); // Defaults party size to 1 on insert, doesn't update existing party size
      }
    });
  } catch (error) {
    console.error("Error parsing email field data:", error);
  }

  res.redirect(`/admin/${eventId}`);
});

app.post('/admin/attendees/copy', (req, res) => {
  const fromEventId = +req.body.from_event;
  const toEventId = +req.body.to_event;
  const rows = db.prepare('SELECT name,email,party_size FROM attendees WHERE event_id=?').all(fromEventId) as {name: string, email: string, party_size: number}[];
  rows.forEach((r) => upsertAttendee(toEventId, r.name, r.email, r.party_size));
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
        console.error(`Event not found for attendee ID ${attendeeId} with event_id ${a.event_id}`);
        res.status(404).send('Error: Associated event not found.'); // Changed to 404
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


app.get('/rsvp/:tok', (req, res) => {
        if (!/^[0-9a-f]{32}$/.test(req.params.tok)) {
            res.status(400).send('Invalid token format');
            return;
        }
        const attendee = db.prepare(
            `SELECT a.*, 
                    e.title AS event_title, 
                    e.date as event_date, 
                    e.description as event_desc,
                    e.banner_image_filename AS event_banner_image_filename 
             FROM attendees a 
             JOIN events e ON a.event_id=e.id 
             WHERE a.token=?`
        ).get(req.params.tok) as AttendeeView | undefined; // Added undefined possibility

        if (!attendee) {
            res.status(404).send('Invalid link');
            return;
        }
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
        ).get(req.params.token) as { name: string; token: string; event_title: string } | undefined; // Added undefined

        if (!a) {
            res.status(404).send('Invalid token or attendee not found.');
            return;
        }
        const finalPartySize = parseInt(party_size, 10);
        if (isNaN(finalPartySize) || finalPartySize < 1) {
            // Handle invalid party size from RSVP form, perhaps redirect back with error
            // For now, let's default to 1 if 'yes', or keep existing if 'no' (though form should disable it)
            // This part needs careful consideration based on UX for RSVP form.
            // Assuming party_size is validated on client or required.
            // If rsvp is 'no', party_size might not matter or be 0.
            // The DB update will take the value.
        }


        db.prepare('UPDATE attendees SET rsvp=?,party_size=?,responded_at=? WHERE token=?')
            .run(rsvp, finalPartySize, now, req.params.token);
        await notifyAdmin(a, rsvp, finalPartySize);
        res.render('thanks', { rsvp, party_size: finalPartySize });
    }
);

// Error handling for Multer (e.g., file too large, wrong type)
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof multer.MulterError) {
    // A Multer error occurred when uploading.
    console.error('Multer Error:', err);
    // Redirect back or send error message. For simplicity, redirecting to admin for now.
    // You might want to use connect-flash for flash messages.
    if (req.params.eventId) {
        return res.redirect(`/admin/${req.params.eventId}?error=${encodeURIComponent(err.message)}`);
    }
    return res.redirect('/admin?error=' + encodeURIComponent(err.message));
  } else if (err && err.message === 'Invalid file type. Only JPEG, PNG, and GIF are allowed.') {
    console.error('File Type Error:', err);
    if (req.params.eventId) {
        return res.redirect(`/admin/${req.params.eventId}?error=${encodeURIComponent(err.message)}`);
    }
    return res.redirect('/admin?error=' + encodeURIComponent(err.message));
  } else if (err) {
    // An unknown error occurred.
    next(err);
  } else {
    next();
  }
});


// CSRF Error Handler
// This must be defined after all routes that use CSRF protection and other error handlers
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err.code === 'EBADCSRFTOKEN') {
    console.error('CSRF Token Error:', err);
    res.status(403).send('Form tampered with or session expired - please try again.');
  } else {
    // If it's not a CSRF error, pass it to the default Express error handler (or other custom error handlers)
    // This is important if the multer error handler above calls next(err) for non-multer errors.
    next(err); 
  }
});
