// src/server.ts
// Main server configuration and middleware setup

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
import session from 'express-session';
import csurf from 'csurf';
import multer from 'multer';
import fs from 'fs';

// Import modular components
import { initializeDatabase, getDatabase } from './database';
import publicRoutes from './routes/public';
import adminRoutes from './routes/admin';
import attendeeRoutes from './routes/attendees';

// ============================================================================
// Configuration
// ============================================================================

export const PORT = process.env.PORT ?? '3000';
export const APP_BASE_URL = process.env.APP_BASE_URL ?? `http://localhost:${PORT}`;
const DB_PATH = process.env.DB_PATH ?? './rsvp.sqlite';
const EVENT_BANNER_STORAGE_PATH = process.env.EVENT_BANNER_STORAGE_PATH || './data/uploads/event-banners';
const SESSION_SECRET = process.env.SESSION_SECRET || 'your-super-secret-and-long-random-string';

// ============================================================================
// Express App Setup
// ============================================================================

const app = express();

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));

// Make APP_BASE_URL available to all EJS templates
app.locals.APP_BASE_URL = APP_BASE_URL;

// Static file serving
app.use('/static', express.static(path.join(__dirname, '../public')));
app.use('/uploads/event-banners', express.static(EVENT_BANNER_STORAGE_PATH));

// Ensure banner upload directory exists
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
}));

// CSRF protection middleware
const csrfProtection = csurf();

// ============================================================================
// Multer Configuration (for file uploads)
// ============================================================================

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, EVENT_BANNER_STORAGE_PATH);
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

export const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }
});

// ============================================================================
// Database Initialization
// ============================================================================

initializeDatabase(DB_PATH);
export const db = getDatabase();

// ============================================================================
// Routes
// ============================================================================

// Public routes
app.use('/', upload.none(), csrfProtection, publicRoutes);

// Admin + attendee routes (protected by reverse proxy auth - no built-in authentication)
// Multer runs before CSRF so multipart forms (with or without files) populate req.body/_csrf
app.use('/admin', upload.single('banner_image'), csrfProtection, adminRoutes, attendeeRoutes);

// ============================================================================
// Error Handling
// ============================================================================

// Multer error handler
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

// CSRF error handler
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

export default app;
