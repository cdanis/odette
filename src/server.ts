// src/server.ts
import * as express from 'express';
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
const SMTP_USER = process.env.SMTP_USER!;
const SMTP_PASS = process.env.SMTP_PASS!;
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const NTFY_BASE_URL = (process.env.NTFY_BASE_URL ?? 'https://ntfy.sh').replace(/\/+$/, '');
const NTFY_USER = process.env.NTFY_USER;
const NTFY_PASS = process.env.NTFY_PASS;

export const app = express.default();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true }));
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
  await transporter.sendMail({ from: SMTP_USER, to: email, subject: 'You\'re Invited! Please RSVP', html });
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

type AttendeeView = { id:number; event_id:number; name:string; email:string; party_size:number; is_sent:number; rsvp:string|null; responded_at:number|null; event_title:string; event_date:number; event_desc:string; };

app.get('/admin', (req, res) => {
  const events = db.prepare('SELECT * FROM events ORDER BY date').all();
  const attendees = db.prepare(
    'SELECT a.*, e.title AS event_title FROM attendees a JOIN events e ON a.event_id=e.id ORDER BY e.date,a.name'
  ).all() as AttendeeView[];
  res.render('admin', { events, attendees });
});

app.post('/admin/event', (req, res) => {
  db.prepare('INSERT INTO events (title,date,description) VALUES (?,?,?)')
    .run(req.body.title, new Date(req.body.date).getTime(), req.body.description);
  res.redirect('/admin');
});

app.post('/admin/attendee', (req, res) => {
  upsertAttendee(+req.body.event_id, req.body.name, req.body.email, +req.body.party_size||1);
  res.redirect('/admin');
});

app.post('/admin/attendees/batch', (req, res) => {
  req.body.csv.split(/\r?\n/).forEach((line: string) => {
    const [name, email, party] = line.split(',').map((s: string) => s.trim());
    if (name && email) upsertAttendee(+req.body.event_id, name, email, +(party||1));
  });
  res.redirect('/admin');
});

app.post('/admin/attendees/copy', (req, res) => {
  const rows = db.prepare('SELECT name,email,party_size FROM attendees WHERE event_id=?').all(+req.body.from_event);
  rows.forEach((r: any) => upsertAttendee(+req.body.to_event, r.name, r.email, r.party_size));
  res.redirect('/admin');
});

interface Invitee { id: number; name: string; email: string; token: string; }
app.post('/admin/attendees/send/:id', async (req, res) => {
  const id = +req.params.id;
  const a = db.prepare('SELECT id,name,email,token FROM attendees WHERE id=?').get(id) as Invitee | undefined;
  if (a) { await sendInvitation(a.name, a.email, a.token); db.prepare('UPDATE attendees SET is_sent=1 WHERE id=?').run(id); }
  res.redirect('/admin');
});

app.post('/admin/events/:id/send-invites', async (req, res) => {
  const pending = db.prepare('SELECT id,name,email,token FROM attendees WHERE event_id=? AND is_sent=0').all(+req.params.id) as Invitee[];
  for (const a of pending) { await sendInvitation(a.name, a.email, a.token); db.prepare('UPDATE attendees SET is_sent=1 WHERE id=?').run(a.id); }
  res.redirect('/admin');
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
        const a = db.prepare(
            'SELECT a.name,e.title AS event_title FROM attendees a JOIN events e ON a.event_id=e.id WHERE a.token=?'
        ).get(+req.params.token) as { name: string; event_title: string };
        db.prepare('UPDATE attendees SET rsvp=?,party_size=?,responded_at=? WHERE token=?')
            .run(rsvp, +party_size, now, req.params.token);
        await notifyAdmin(a, rsvp, +party_size);
        res.render('thanks', { rsvp, party_size });
    }

);
