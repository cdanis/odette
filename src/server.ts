// src/server.ts
import express from 'express';
import * as path from 'path';
import * as bodyParser from 'body-parser';
import * as nodemailer from 'nodemailer';
import * as Database from 'better-sqlite3';
import * as crypto from 'crypto';

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

export const app = express();
app.set('view engine', 'ejs');
// Assuming 'views' directory is at the project root, sibling to 'src' and 'dist'
app.set('views', path.join(__dirname, '../views'));
app.use(bodyParser.urlencoded({ extended: true }));
// Assuming 'public' directory is copied to 'dist/public' during build
app.use('/static', express.static(path.join(__dirname, 'public')));

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

export async function sendInvitation(name: string, email: string, token: string) {
  const link = `${APP_BASE_URL}/rsvp/${token}`;
  const html = `<p>Hi ${name},</p>\n<p>Please RSVP here: <a href=\"${link}\">${link}</a></p>`;
  await console.log(`Sending invite to ${email}`, { from: SMTP_USER, to: email, subject: 'You\'re Invited! Please RSVP', html });
  if (SMTP_USER && SMTP_PASS) {
    await transporter.sendMail({ from: SMTP_USER, to: email, subject: 'You\'re Invited! Please RSVP', html });
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

export function upsertAttendee(event_id: number, name: string, email: string, party_size: number) {
  const stmtSelect = db.prepare('SELECT id, party_size FROM attendees WHERE event_id=? AND email=?');
  const existing = stmtSelect.get(event_id, email) as ExistingAttendee | undefined;
  if (existing) {
    if (existing.party_size !== party_size) {
      db.prepare('UPDATE attendees SET party_size=? WHERE id=?')
        .run(party_size, existing.id);
    }
  } else {
    const token = generateToken();
    db.prepare('INSERT INTO attendees (event_id,name,email,party_size,token) VALUES (?,?,?,?,?)')
      .run(event_id, name, email, party_size, token);
  }
}

type EventRecord = { id: number; title: string; date: number; description: string | null; };
type AttendeeView = { id:number; event_id:number; name:string; email:string; party_size:number; is_sent:number; rsvp:string|null; responded_at:number|null; event_title:string; event_date:number; event_desc:string; token: string; };
// Simplified Attendee for event-admin page, event_title is known from context
type EventAttendeeView = { id:number; event_id:number; name:string; email:string; party_size:number; token: string; is_sent:number; rsvp:string|null; responded_at:number|null; };


app.get('/admin', (req, res) => {
  const events = db.prepare('SELECT * FROM events ORDER BY date').all() as EventRecord[];
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
  const allEvents = db.prepare('SELECT id, title FROM events WHERE id != ? ORDER BY title').all(eventId) as {id: number, title: string}[]; // For "copy from" dropdown

  res.render('event-admin', { event, attendees, allEvents });
});

app.post('/admin/event', (req, res) => {
  db.prepare('INSERT INTO events (title,date,description) VALUES (?,?,?)')
    .run(req.body.title, new Date(req.body.date).getTime(), req.body.description);
  res.redirect('/admin');
});

app.post('/admin/event/:eventId/update', (req, res) => {
  const eventId = +req.params.eventId;
  const { title, date, description } = req.body;
  // Ensure date is stored as a timestamp
  const dateTimestamp = new Date(date).getTime();
  db.prepare('UPDATE events SET title = ?, date = ?, description = ? WHERE id = ?')
    .run(title, dateTimestamp, description, eventId);
  res.redirect(`/admin/${eventId}`);
});

app.post('/admin/attendee', (req, res) => { // Assumes event_id is in body
  const eventId = +req.body.event_id;
  upsertAttendee(eventId, req.body.name, req.body.email, +req.body.party_size||1);
  res.redirect(`/admin/${eventId}`);
});

app.post('/admin/attendees/batch', (req, res) => { // Assumes event_id is in body
  const eventId = +req.body.event_id;
  req.body.csv.split(/\r?\n/).forEach((line: string) => {
    const [name, email, party] = line.split(',').map((s: string) => s.trim());
    if (name && email) upsertAttendee(eventId, name, email, +(party||1));
  });
  res.redirect(`/admin/${eventId}`);
});

app.post('/admin/attendees/copy', (req, res) => {
  const fromEventId = +req.body.from_event;
  const toEventId = +req.body.to_event; // This will be the current event's ID from hidden field in event-admin.ejs
  const rows = db.prepare('SELECT name,email,party_size FROM attendees WHERE event_id=?').all(fromEventId);
  rows.forEach((r: any) => upsertAttendee(toEventId, r.name, r.email, r.party_size));
  res.redirect(`/admin/${toEventId}`);
});

interface InviteeWithEventId extends Invitee { event_id: number; }
interface Invitee { id: number; name: string; email: string; token: string; }

app.post('/admin/attendees/send/:attendeeId', async (req, res) => {
  const attendeeId = +req.params.attendeeId;
  // Fetch event_id along with attendee details for redirection
  const a = db.prepare('SELECT id, name, email, token, event_id FROM attendees WHERE id=?').get(attendeeId) as InviteeWithEventId | undefined;
  if (a) {
    await sendInvitation(a.name, a.email, a.token);
    db.prepare('UPDATE attendees SET is_sent=1 WHERE id=?').run(attendeeId);
    res.redirect(`/admin/${a.event_id}`);
  } else {
    res.status(404).send('Attendee not found'); // Or redirect to /admin if preferred
  }
});

app.post('/admin/events/:eventId/send-invites', async (req, res) => {
  const eventId = +req.params.eventId;
  const pending = db.prepare('SELECT id,name,email,token FROM attendees WHERE event_id=? AND is_sent=0').all(eventId) as Invitee[];
  for (const a of pending) {
    await sendInvitation(a.name, a.email, a.token);
    db.prepare('UPDATE attendees SET is_sent=1 WHERE id=?').run(a.id);
  }
  res.redirect(`/admin/${eventId}`);
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
        res.render('rsvp', { attendee });
});

app.post('/rsvp/:token', async (req, res) => {
    if (!/^[0-9a-f]{32}$/.test(req.params.token)) {
        res.status(400).send('Invalid token format');
        return;
    }
        const { rsvp, party_size } = req.body;
        const now = Date.now();
        // Corrected: req.params.token is a string, not to be converted to number with +
        const a = db.prepare(
            'SELECT a.name, a.token, e.title AS event_title FROM attendees a JOIN events e ON a.event_id=e.id WHERE a.token=?'
        ).get(req.params.token) as { name: string; token: string; event_title: string }; // Added token here for AttendeeView consistency

        if (!a) { // Attendee not found for the given token
            res.status(404).send('Invalid token or attendee not found.');
            return;
        }

        db.prepare('UPDATE attendees SET rsvp=?,party_size=?,responded_at=? WHERE token=?')
            .run(rsvp, +party_size, now, req.params.token);
        await notifyAdmin(a, rsvp, +party_size);
        res.render('thanks', { rsvp, party_size });
    }
);
