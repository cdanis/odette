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

// Make APP_BASE_URL available to all EJS templates
app.locals.APP_BASE_URL = APP_BASE_URL;

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
  date_end INTEGER,
  timezone TEXT
)`).run();

const columnsToAddEvents = [
    { name: 'banner_image_filename', type: 'TEXT' },
    { name: 'location_name', type: 'TEXT' },
    { name: 'location_href', type: 'TEXT' },
    { name: 'date_end', type: 'INTEGER' },
    { name: 'timezone', type: 'TEXT' }
];

columnsToAddEvents.forEach(col => {
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
  email TEXT NOT NULL, -- This is the primary email
  party_size INTEGER NOT NULL DEFAULT 1,
  token TEXT NOT NULL UNIQUE,
  is_sent INTEGER NOT NULL DEFAULT 0,
  rsvp TEXT DEFAULT NULL,
  responded_at INTEGER DEFAULT NULL,
  last_modified INTEGER,
  additional_emails TEXT, -- Stores JSON array of additional emails
  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
)`).run(); 

// Check and add last_modified to attendees table
try {
    db.prepare(`SELECT last_modified FROM attendees LIMIT 1`).get();
} catch (error) {
    console.log(`Attempting to add last_modified column to attendees table...`);
    try {
        db.prepare(`ALTER TABLE attendees ADD COLUMN last_modified INTEGER`).run();
        console.log(`Column last_modified added successfully to attendees table.`);
    } catch (alterError) {
        console.error(`Failed to add last_modified column to attendees:`, alterError);
    }
}

// Check and add additional_emails to attendees table
try {
    db.prepare(`SELECT additional_emails FROM attendees LIMIT 1`).get();
} catch (error) {
    console.log(`Attempting to add additional_emails column to attendees table...`);
    try {
        // Store as TEXT, ensure it's valid JSON array, default to NULL
        // SQLite's json_type will return 'array' for valid JSON arrays, and 'null' for JSON null.
        db.prepare(`ALTER TABLE attendees ADD COLUMN additional_emails TEXT CHECK(json_valid(additional_emails) AND json_type(additional_emails) IN ('array', 'null'))`).run();
        console.log(`Column additional_emails added successfully to attendees table.`);
    } catch (alterError) {
        console.error(`Failed to add additional_emails column to attendees:`, alterError);
    }
}


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
// and optionally convert HTML to plain text
function escapeICSText(text: string | null | undefined, isHtmlContent: boolean = false): string {
  if (text === null || typeof text === 'undefined') return '';

  let processedText = String(text); // Ensure it's a string

  if (isHtmlContent) {
    // 1. Convert <br> tags to newlines
    processedText = processedText.replace(/<br\s*\/?>/gi, '\n');
    // 2. Strip all other HTML tags
    processedText = processedText.replace(/<[^>]+>/g, '');
    // 3. Decode common HTML entities
    // Order is important: &amp; first
    processedText = processedText.replace(/&amp;/g, '&')
                                 .replace(/&lt;/g, '<')
                                 .replace(/&gt;/g, '>')
                                 .replace(/&quot;/g, '"')
                                 .replace(/&#039;/g, "'") // Numeric entity for single quote
                                 .replace(/&apos;/g, "'") // Named entity for single quote
                                 .replace(/&nbsp;/g, ' '); // Non-breaking space to space
    // 4. Trim whitespace that might be left around after stripping tags
    processedText = processedText.trim();
  }

  // Escape characters for ICS format
  return processedText
    .replace(/\\/g, '\\\\') // Must be first: escape backslashes
    .replace(/\r/g, '')     // Remove carriage returns
    .replace(/\n/g, '\\n')  // Escape newlines (convert LF to literal \n)
    .replace(/,/g, '\\,')   // Escape commas
    .replace(/;/g, '\\;');  // Escape semicolons
}

// Helper function to convert HTML to plain text for email body
function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return '';
  let text = String(html);
  // Convert <br> and <p> tags to newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>\s*<p>/gi, '\n\n'); // Convert paragraph breaks to double newlines
  // Strip all other HTML tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&quot;/g, '"')
             .replace(/&#039;/g, "'")
             .replace(/&apos;/g, "'")
             .replace(/&nbsp;/g, ' '); // Non-breaking space to space
  return text.trim();
}


export async function sendInvitation(name: string, primaryEmail: string, ccEmails: string[], token: string, event: EventRecord) {
  const rsvpLink = `${APP_BASE_URL}/rsvp/${token}`;
  const icsLink = `${APP_BASE_URL}/ics/${token}`;

  // Date formatting
  const startDate = new Date(event.date);
  const baseDateOptions: Intl.DateTimeFormatOptions = { dateStyle: 'full', timeStyle: 'short' };
  const effectiveDateOptions: Intl.DateTimeFormatOptions = event.timezone 
    ? { ...baseDateOptions, timeZone: event.timezone }
    : baseDateOptions;
  
  let whenString = startDate.toLocaleString(undefined, effectiveDateOptions);

  if (event.date_end) {
    const endDate = new Date(event.date_end);
    const timeOnlyOptions: Intl.DateTimeFormatOptions = event.timezone
      ? { timeStyle: 'short', timeZone: event.timezone }
      : { timeStyle: 'short' };

    // Compare dates in the event's timezone (or server default if event.timezone is not set)
    const tzForComparison = event.timezone || undefined;
    if (startDate.toLocaleDateString(undefined, {timeZone: tzForComparison}) === endDate.toLocaleDateString(undefined, {timeZone: tzForComparison})) { 
      whenString += ` to ${endDate.toLocaleTimeString(undefined, timeOnlyOptions)}`;
    } else { 
      whenString += ` to ${endDate.toLocaleString(undefined, effectiveDateOptions)}`;
    }
  }

  // Location formatting
  let locationHtml = '';
  if (event.location_name && event.location_href) {
    locationHtml = `<a href="${event.location_href}" target="_blank">${event.location_name}</a>`;
  } else if (event.location_name) {
    locationHtml = event.location_name;
  } else if (event.location_href) {
    locationHtml = `<a href="${event.location_href}" target="_blank">${event.location_href}</a>`;
  }

  // Description formatting
  const plainDescription = htmlToPlainText(event.description);

  const html = `
    <p>Hi ${name},</p>
    <p>You are invited to <strong>${event.title}</strong>.</p>
    
    <hr style="margin: 20px 0;">

    <p><strong>When:</strong><br>${whenString}</p>
    
    ${locationHtml ? `<p><strong>Where:</strong><br>${locationHtml}</p>` : ''}
    
    ${plainDescription ? `
      <p><strong>Event Details:</strong></p>
      <div style="white-space: pre-wrap; padding: 10px; border: 1px solid #eeeeee; background-color: #f9f9f9; border-radius: 4px; margin-top: 5px;">${plainDescription}</div>
    ` : ''}
    
    <hr style="margin: 20px 0;">

    <p>Please RSVP here: <a href="${rsvpLink}">${rsvpLink}</a></p>
    <p>Add to your calendar: <a href="${icsLink}">Download Calendar File (.ics)</a></p>
  `;

  const subject = `Invitation: ${event.title}`;
  const logRecipients = `To: ${primaryEmail}${ccEmails.length > 0 ? `, Cc: ${ccEmails.join(', ')}` : ''}`;
  console.log(`Preparing to send invite ${logRecipients} for event "${event.title}" (Timezone for email: ${event.timezone || 'Server Default'})`);

  if (SMTP_USER && SMTP_PASS) {
    try {
      await transporter.sendMail({ 
        from: SMTP_USER, 
        to: primaryEmail, 
        cc: ccEmails.length > 0 ? ccEmails : undefined, 
        subject, 
        html, 
        text: htmlToPlainText(html) 
      });
      console.log(`Invite successfully sent ${logRecipients}`);
    } catch (error) {
      console.error(`Failed to send invite ${logRecipients} for event "${event.title}". Error:`, error);
      throw error; // Re-throw to allow caller to handle
    }
  } else {
    console.log(`SMTP not configured. Mock sending invite ${logRecipients}: Subject: ${subject}, Body: ${html}`);
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

interface ExistingAttendee { 
    id: number; 
    party_size: number; 
    additional_emails?: string | null; // JSON string
}

export function upsertAttendee(event_id: number, name: string, primaryEmail: string, party_size?: number, additionalEmailsArray?: string[]) {
  const stmtSelect = db.prepare('SELECT id, party_size, additional_emails FROM attendees WHERE event_id=? AND email=?');
  const existing = stmtSelect.get(event_id, primaryEmail.trim().toLowerCase()) as ExistingAttendee | undefined;
  const finalPartySize = party_size === undefined || isNaN(party_size) || party_size < 1 ? 1 : party_size;
  const now = Date.now();

  // Prepare additional_emails JSON string
  // Filter out empty strings, trim, ensure uniqueness, and exclude primaryEmail
  const uniqueAdditionalEmails = additionalEmailsArray 
    ? [...new Set(
        additionalEmailsArray
          .map(e => e.trim().toLowerCase())
          .filter(e => e && e !== primaryEmail.trim().toLowerCase())
      )] 
    : [];
  const additionalEmailsJson = uniqueAdditionalEmails.length > 0 ? JSON.stringify(uniqueAdditionalEmails) : null;

  if (existing) {
    const attendeeId = existing.id;
    const rsvpStatus = db.prepare('SELECT rsvp FROM attendees WHERE id = ?').get(attendeeId) as { rsvp: string | null } | undefined;
    
    let updateQuery = 'UPDATE attendees SET last_modified=?';
    const updateParams: (number | string | null)[] = [now];

    if (rsvpStatus && rsvpStatus.rsvp === null) { // Only update party size if no RSVP yet
        if (party_size !== undefined && existing.party_size !== finalPartySize) {
            updateQuery += ', party_size=?';
            updateParams.push(finalPartySize);
        }
    }
    
    // Update additional_emails if they differ
    if (additionalEmailsJson !== existing.additional_emails) {
        updateQuery += ', additional_emails=?';
        updateParams.push(additionalEmailsJson);
    }
    
    updateParams.push(attendeeId);

    // Only run update if there's something to change besides last_modified
    if (updateQuery !== 'UPDATE attendees SET last_modified=?') {
        db.prepare(`${updateQuery} WHERE id=?`).run(...updateParams);
    } else { 
        // If only last_modified needs update (nothing else changed), still run an update for last_modified.
        // This handles cases where the function is called but no actual data changed, but we still want to record the "touch".
        db.prepare('UPDATE attendees SET last_modified=? WHERE id=?').run(now, attendeeId);
    }

  } else {
    const token = generateToken();
    db.prepare('INSERT INTO attendees (event_id,name,email,party_size,token,last_modified,additional_emails) VALUES (?,?,?,?,?,?,?)')
      .run(event_id, name, primaryEmail.trim().toLowerCase(), finalPartySize, token, now, additionalEmailsJson);
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
  timezone?: string | null;
};
type AttendeeView = { 
  id:number; 
  event_id:number; 
  name:string; 
  email:string; // Primary email
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
  event_timezone?: string | null; 
  additional_emails?: string | null; // JSON string
};
type EventAttendeeView = { 
  id:number; 
  event_id:number; 
  name:string; 
  email:string; // Primary email
  party_size:number; 
  token: string; 
  is_sent:number; 
  rsvp:string|null; 
  responded_at:number|null; 
  last_modified: number | null;
  additional_emails?: string | null; // JSON string
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

// Get IANA timezones
let timezones: string[] = [];
try {
    if (typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function') {
        timezones = Intl.supportedValuesOf('timeZone');
    } else {
        throw new Error("Intl.supportedValuesOf('timeZone') is not available.");
    }
} catch (e) {
    console.warn("Could not get IANA timezones using Intl.supportedValuesOf('timeZone'). Using a fallback list.", e);
    timezones = [ // Basic fallback list
        'UTC', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 
        'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
        'Asia/Tokyo', 'Asia/Dubai', 'Asia/Kolkata', 'Australia/Sydney',
        // Add more common timezones if needed
    ];
}


// Landing Page Route
app.get('/', (req, res) => {
  res.render('landing');
});

app.get('/admin', csrfProtection, (req, res) => {
  const eventsRaw = db.prepare('SELECT * FROM events ORDER BY date').all() as EventRecord[];
  const events: EventRecordWithStats[] = eventsRaw.map(event => ({
    ...event,
    stats: getEventAttendeeStats(event.id)
  }));
  res.render('admin', { events, csrfToken: req.csrfToken(), timezones });
});

app.get('/admin/:eventId', csrfProtection, (req, res) => {
  const eventId = +req.params.eventId;
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as EventRecord | undefined;
  if (!event) {
    res.status(404).send('Event not found');
    return;
  }
  const attendees = db.prepare(
    'SELECT id, event_id, name, email, party_size, token, is_sent, rsvp, responded_at, last_modified, additional_emails FROM attendees WHERE event_id = ? ORDER BY name'
  ).all(eventId) as EventAttendeeView[];
  const allEvents = db.prepare('SELECT id, title FROM events WHERE id != ? ORDER BY title').all(eventId) as {id: number, title: string}[];
  const attendeeStats = getEventAttendeeStats(eventId);

  res.render('event-admin', { event, attendees, allEvents, attendeeStats, csrfToken: req.csrfToken(), timezones });
});

app.post('/admin/event', upload.single('banner_image'), csrfProtection, (req, res) => {
  const { title, date, description, location_name, location_href, date_end, timezone } = req.body;
  const dateTimestamp = new Date(date).getTime();
  let dateEndTimestamp: number | null = null;
  if (date_end) {
    const parsedEnd = new Date(date_end).getTime();
    if (!isNaN(parsedEnd)) {
        dateEndTimestamp = parsedEnd;
    }
  }
  
  const result = db.prepare(
    'INSERT INTO events (title, date, description, banner_image_filename, location_name, location_href, date_end, timezone) VALUES (?,?,?,?,?,?,?,?)'
    ).run(title, dateTimestamp, description, null, location_name || null, location_href || null, dateEndTimestamp, timezone || null);
  
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
  const { title, date, description, location_name, location_href, date_end, timezone } = req.body;
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
        'UPDATE events SET title = ?, date = ?, description = ?, banner_image_filename = ?, location_name = ?, location_href = ?, date_end = ?, timezone = ? WHERE id = ?'
        ).run(title, dateTimestamp, description, newBannerFilename, location_name || null, location_href || null, dateEndTimestamp, timezone || null, eventId);
  } else {
    db.prepare(
        'UPDATE events SET title = ?, date = ?, description = ?, location_name = ?, location_href = ?, date_end = ?, timezone = ? WHERE id = ?'
        ).run(title, dateTimestamp, description, location_name || null, location_href || null, dateEndTimestamp, timezone || null, eventId);
  }
  res.redirect(`/admin/${eventId}`);
});

app.post('/admin/attendee', csrfProtection, (req, res) => {
  const eventId = +req.body.event_id;
  const partySize = parseInt(req.body.party_size, 10);
  const primaryEmail = req.body.email; // This is the 'Primary Email' field
  const additionalEmailsRaw = req.body.additional_emails || ''; // New field from textarea
  
  let additionalEmailsList: string[] = [];
  if (additionalEmailsRaw && typeof additionalEmailsRaw === 'string') {
    additionalEmailsList = additionalEmailsRaw
      .split(/[\n,]+/) // Split by newline or comma
      .map(e => e.trim())
      .filter(e => e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)); // Basic email validation
  }

  upsertAttendee(eventId, req.body.name, primaryEmail, isNaN(partySize) || partySize < 1 ? 1 : partySize, additionalEmailsList);
  res.redirect(`/admin/${eventId}`);
});

app.post('/admin/attendees/batch', csrfProtection, (req, res) => {
  const eventId = +req.body.event_id;
  req.body.csv.split(/\r?\n/).forEach((line: string) => {
    const [name, email, partyStr] = line.split(',').map((s: string) => s.trim());
    if (name && email) {
      const party = parseInt(partyStr, 10);
      // For batch, additional emails are not provided in CSV, so pass undefined or empty array
      upsertAttendee(eventId, name, email, isNaN(party) || party < 1 ? 1 : party, []);
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
        // For parsed emails, additional emails are not provided, so pass undefined or empty array
        upsertAttendee(eventId, name, email, 1, []); 
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

interface InviteeWithEventIdAndEmails { 
  id: number; 
  name: string; 
  email: string; // Primary email
  token: string; 
  event_id: number; 
  additional_emails: string | null; // JSON string
}
interface InviteeForBatch extends InviteeWithEventIdAndEmails {}


app.post('/admin/attendees/send/:attendeeId', csrfProtection, async (req, res) => {
  const attendeeId = +req.params.attendeeId;
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
          .filter(e => e && e !== primaryEmail); // Ensure they are valid strings and not the primary
      }
    } catch (e) {
      console.error(`Error parsing additional_emails for attendee ${a.id}:`, e);
      // Continue with primary email even if parsing additional fails
    }
  }

  try {
    await sendInvitation(a.name, primaryEmail, ccEmails, a.token, event);
    db.prepare('UPDATE attendees SET is_sent=1, last_modified=? WHERE id=?').run(Date.now(), attendeeId);
  } catch (error) {
    // Error is already logged by sendInvitation
    // Optionally, add a specific error message to the redirect
    const errorMessage = encodeURIComponent('Failed to send invitation. Check server logs.');
    res.redirect(`/admin/${a.event_id}?error=${errorMessage}`);
    return;
  }
  
  res.redirect(`/admin/${a.event_id}`);
});

app.post('/admin/events/:eventId/send-invites', csrfProtection, async (req, res) => {
  const eventId = +req.params.eventId;
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as EventRecord | undefined;
  const now = Date.now();

  if (!event) {
    console.error(`Event not found with ID ${eventId} when trying to send batch invites.`);
    res.status(404).send('Event not found.');
    return;
  }

  const pending = db.prepare('SELECT id, name, email, token, additional_emails, event_id FROM attendees WHERE event_id=? AND is_sent=0')
                    .all(eventId) as InviteeForBatch[];
  
  let overallSuccess = true;
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
      await sendInvitation(a.name, primaryEmail, ccEmails, a.token, event);
      db.prepare('UPDATE attendees SET is_sent=1, last_modified=? WHERE id=?').run(now, a.id);
    } catch (sendError) {
      // Error is logged by sendInvitation. Mark overall success as false.
      overallSuccess = false;
      console.error(`Failed to send batch invite for attendee ${a.id} (To: ${primaryEmail}, CC: ${ccEmails.join(', ')}). Continuing with others.`);
      // Continue to next attendee
    }
  }

  if (!overallSuccess) {
      const errorMessage = encodeURIComponent('Some invitations could not be sent. Please check server logs for details.');
      res.redirect(`/admin/${eventId}?error=${errorMessage}`);
  } else {
      res.redirect(`/admin/${eventId}`);
  }
});

app.post('/admin/attendee/:attendeeId/update-party-size', csrfProtection, (req, res) => {
  const attendeeId = +req.params.attendeeId;
  const newPartySize = parseInt(req.body.party_size, 10);
  const now = Date.now();

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

  const result = db.prepare('UPDATE attendees SET party_size = ?, last_modified = ? WHERE id = ? AND rsvp IS NULL')
                   .run(newPartySize, now, attendeeId);

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

    db.prepare('UPDATE attendees SET rsvp=?, party_size=?, responded_at=?, last_modified=? WHERE token=?')
        .run(rsvp, finalPartySize, now, now, req.params.token);
    
    await notifyAdmin(attendeeData, rsvp, (rsvp === 'yes' ? finalPartySize : 0));
    
    res.render('thanks', { 
        rsvp, 
        party_size: (rsvp === 'yes' ? finalPartySize : 0),
        token: req.params.token // Pass token to the template
    });
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
            e.location_href AS event_location_href,
            e.date_end AS event_date_end
            -- e.timezone is not directly used for ICS generation as ICS uses UTC
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
  const domain = APP_BASE_URL.replace(/^https?:\/\//, '').split('/')[0];
  const rsvpLink = `${APP_BASE_URL}/rsvp/${req.params.token}`;

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
  // Process the combined description (original event_desc as HTML, appended link as plain text)
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
