/*
 * Simple RSVP System with Events, Party Size, Draft Mode, Admin Notifications, Batch Add, and Copy
 * - Node.js + TypeScript
 * - SQLite via better-sqlite3
 * - Express for routing
 * - EJS templates for minimal aesthetic + theming
 * - Nodemailer for Gmail SMTP
 * - Unique link per attendee
 * - Draft attendee lists (is_sent flag)
 * - Optional admin notifications via ntfy.sh/custom instance with HTTP Basic Auth
 * - Batch-add attendees via CSV textarea (dedupe/update by email)
 * - Copy attendees from a previous event (dedupe by email)
 */

import express from 'express';
import path from 'path';
import bodyParser from 'body-parser';
import nodemailer from 'nodemailer';
import Database from 'better-sqlite3';
import crypto from 'crypto';

// ---------- CONFIGURATION ----------
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || './rsvp.sqlite';
const SMTP_USER = process.env.SMTP_USER!;
const SMTP_PASS = process.env.SMTP_PASS!;
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
// ntfy config
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const NTFY_BASE_URL = process.env.NTFY_BASE_URL || 'https://ntfy.sh';
const NTFY_USER = process.env.NTFY_USER;
const NTFY_PASS = process.env.NTFY_PASS;

// ---------- INITIALIZATION ----------
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/static', express.static(path.join(__dirname, 'public')));

const db = new Database(DB_PATH);
// Tables
db.prepare(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    date INTEGER NOT NULL,
    description TEXT
  )
`).run();
db.prepare(`
  CREATE TABLE IF NOT EXISTS attendees (
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
  )
`).run();

// Nodemailer
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});

// ---------- HELPERS ----------
function generateToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

async function sendInvitation(name: string, email: string, token: string) {
  const link = `${APP_BASE_URL}/rsvp/${token}`;
  const html = `<p>Hi ${name},</p>\n<p>Please RSVP here: <a href=\"${link}\">${link}</a></p>`;
  await transporter.sendMail({ from: SMTP_USER, to: email, subject: 'You\'re Invited! Please RSVP', html });
}

async function notifyAdmin(att: any, rsvp: string, partySize: number) {
  if (!NTFY_TOPIC) return;
  const title = `RSVP: ${att.name}`;
  const msg = `Event: ${att.event_title}\nResponse: ${rsvp}\nParty Size: ${partySize}`;
  const url = `${NTFY_BASE_URL.replace(/\/+$/, '')}/${NTFY_TOPIC}`;
  const headers: Record<string,string> = { 'Title': title };
  if (NTFY_USER && NTFY_PASS) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${NTFY_USER}:${NTFY_PASS}`).toString('base64');
  }
  try { await fetch(url, { method: 'POST', headers, body: msg }); } catch (e) { console.error('ntfy error', e); }
}

/**
 * Insert or update attendees by email for an event
 * - If email exists: update party_size (and leave existing token/is_sent)
 * - Else: insert new with generated token
 */
function upsertAttendee(event_id: number, name: string, email: string, party_size: number) {
  const existing = db.prepare(
    'SELECT id, party_size FROM attendees WHERE event_id = ? AND email = ?'
  ).get(event_id, email);
  if (existing) {
    // update party size if changed
    if (existing.party_size !== party_size) {
      db.prepare('UPDATE attendees SET party_size = ? WHERE id = ?')
        .run(party_size, existing.id);
    }
  } else {
    const token = generateToken();
    db.prepare(
      'INSERT INTO attendees (event_id, name, email, party_size, token) VALUES (?, ?, ?, ?, ?)'
    ).run(event_id, name, email, party_size, token);
  }
}

// ---------- ROUTES ----------
// Admin view
type AttendeeView = { id:number; event_id:number; name:string; email:string; party_size:number; is_sent:number; rsvp:string|null; responded_at:number|null; event_title:string; };
app.get('/admin', (req, res) => {
  const events = db.prepare('SELECT * FROM events ORDER BY date').all();
  const attendees:AttendeeView[] = db.prepare(
    `SELECT a.*, e.title AS event_title FROM attendees a JOIN events e ON a.event_id=e.id ORDER BY e.date, a.name`
  ).all();
  res.render('admin', { events, attendees });
});

// Create event
app.post('/admin/event', (req, res) => {
  const { title, date, description } = req.body;
  db.prepare('INSERT INTO events (title,date,description) VALUES (?,?,?)')
    .run(title, new Date(date).getTime(), description);
  res.redirect('/admin');
});

// Add single (draft)
app.post('/admin/attendee', (req, res) => {
  const { event_id, name, email, party_size } = req.body;
  upsertAttendee(Number(event_id), name, email, Number(party_size)||1);
  res.redirect('/admin');
});

// Batch-add (draft)
app.post('/admin/attendees/batch', (req, res) => {
  const { event_id, csv } = req.body;
  csv.split(/\r?\n/).forEach(line => {
    const [name, email, party] = line.split(',').map(s => s.trim());
    if (name && email) {
      upsertAttendee(Number(event_id), name, email, party?Number(party):1);
    }
  });
  res.redirect('/admin');
});

// Copy from prev event (draft)
app.post('/admin/attendees/copy', (req, res) => {
  const { from_event, to_event } = req.body;
  const rows = db.prepare(
    'SELECT name,email,party_size FROM attendees WHERE event_id=?'
  ).all(Number(from_event));
  rows.forEach((r:any) => upsertAttendee(Number(to_event), r.name, r.email, r.party_size));
  res.redirect('/admin');
});

// Send single
app.post('/admin/attendees/send/:id', async (req, res) => {
  const id=Number(req.params.id);
  const a=db.prepare('SELECT name,email,token FROM attendees WHERE id=?').get(id);
  if(a){ await sendInvitation(a.name,a.email,a.token); db.prepare('UPDATE attendees SET is_sent=1 WHERE id=?').run(id); }
  res.redirect('/admin');
});

// Send all pending for event
app.post('/admin/events/:id/send-invites', async (req, res) => {
  const eid=Number(req.params.id);
  const pending=db.prepare(
    'SELECT id,name,email,token FROM attendees WHERE event_id=? AND is_sent=0'
  ).all(eid);
  for(const a of pending){ await sendInvitation(a.name,a.email,a.token); db.prepare('UPDATE attendees SET is_sent=1 WHERE id=?').run(a.id); }
  res.redirect('/admin');
});

// RSVP page
app.get('/rsvp/:token',(req,res)=>{
  const attendee=db.prepare(
    `SELECT a.*,e.title AS event_title,e.date,e.description `+
    `FROM attendees a JOIN events e ON a.event_id=e.id WHERE a.token=?`
  ).get(req.params.token);
  if(!attendee) return res.status(404).send('Invalid link');
  res.render('rsvp',{attendee});
});

// Submit RSVP
app.post('/rsvp/:token', async (req,res)=>{
  const { rsvp,party_size }=req.body;
  const now=Date.now();
  const a=db.prepare(
    `SELECT a.name,e.title AS event_title FROM attendees a `+
    `JOIN events e ON a.event_id=e.id WHERE a.token=?`
  ).get(req.params.token);
  db.prepare(
    'UPDATE attendees SET rsvp=?,party_size=?,responded_at=? WHERE token=?'
  ).run(rsvp,party_size,now,req.params.token);
  await notifyAdmin(a,rsvp,Number(party_size));
  res.render('thanks',{rsvp,party_size});
});

// Start server
app.listen(PORT,()=>console.log(`RSVP server at ${APP_BASE_URL}`));

/**
 * Views/admin.ejs forms should use upsert for single, batch, and copy.
 * RSVP and thanks unchanged.
 */
