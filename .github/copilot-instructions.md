# Odette: Event RSVP Management System

## Project Architecture

Odette is a TypeScript Express app for sending event invitations and tracking RSVPs, using SQLite for persistence and EJS for server-side rendering. The codebase is organized into focused modules for maintainability.

### Module Structure

- **[src/server.ts](../src/server.ts)**: Express app setup, middleware configuration, route mounting, error handlers (~170 lines)
- **[src/database.ts](../src/database.ts)**: Database initialization, schema migrations, data access layer (~270 lines)
- **[src/utils.ts](../src/utils.ts)**: Pure utility functions (token generation, date formatting, text processing) (~90 lines)
- **[src/notifications.ts](../src/notifications.ts)**: Email sending via nodemailer and ntfy.sh push notifications (~130 lines)
- **[src/routes/public.ts](../src/routes/public.ts)**: Public-facing routes (landing page, RSVP form, ICS download) (~200 lines)
- **[src/routes/admin.ts](../src/routes/admin.ts)**: Event management routes (CRUD operations, file uploads) (~170 lines)
- **[src/routes/attendees.ts](../src/routes/attendees.ts)**: Attendee management (add, batch, parse emails, send invitations) (~380 lines)

### Key Design Decisions

- **Modular architecture**: Code is organized by concern - database, utilities, notifications, and routes are in separate modules for maintainability and testability.
- **No auth layer**: Admin routes at `/admin` are protected by reverse proxy (e.g., nginx auth). Never implement built-in authentication.
- **Token-based RSVP flow**: Each attendee gets a unique 32-char hex token for RSVP links. Tokens are generated via `crypto.randomBytes(16).toString('hex')` and stored in the `attendees` table.
- **SQLite with runtime migrations**: Schema changes happen via try/catch ALTER TABLE checks at startup (see `initializeDatabase()` in `src/database.ts`). This pattern ensures backward compatibility when adding new columns.
- **Email handling**: Primary emails stored in `attendees.email`, additional CC emails stored as JSON array in `attendees.additional_emails`.

## Database Schema

### Events Table
```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  date INTEGER NOT NULL,           -- JS timestamp (milliseconds)
  date_end INTEGER,                -- Optional end timestamp
  description TEXT,                -- HTML allowed (rendered in emails as plain text)
  timezone TEXT,                   -- IANA timezone for display in emails
  location_name TEXT,
  location_href TEXT,              -- URL for location (e.g., Google Maps)
  banner_image_filename TEXT       -- Filename only, served from EVENT_BANNER_STORAGE_PATH
)
```

### Attendees Table
```sql
CREATE TABLE attendees (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,             -- Primary email (trimmed, lowercased on insert)
  party_size INTEGER NOT NULL DEFAULT 1,
  token TEXT NOT NULL UNIQUE,      -- 32-char hex string
  is_sent INTEGER NOT NULL DEFAULT 0,  -- Boolean: has invite been sent?
  rsvp TEXT DEFAULT NULL,          -- 'yes' or 'no' (NULL = no response yet)
  responded_at INTEGER DEFAULT NULL,   -- JS timestamp
  last_modified INTEGER,           -- JS timestamp for admin tracking
  additional_emails TEXT,          -- JSON array of CC email addresses
  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
)
```

**Important**: Party size cannot be updated after RSVP is submitted (enforced in `/admin/attendee/:attendeeId/update-party-size`).

## Critical Functions

### `upsertAttendee(event_id, name, primaryEmail, party_size?, additionalEmailsArray?)`
Located in [src/database.ts](../src/database.ts). This is the **only** way to create/update attendees:
- Trims and lowercases `primaryEmail` for uniqueness
- Updates `party_size` only if no RSVP exists (`rsvp IS NULL`)
- Preserves `additional_emails` if `additionalEmailsArray` is `undefined`
- Always updates `last_modified` timestamp

### `sendInvitation(name, primaryEmail, ccEmails, token, event, appBaseUrl)`
Located in [src/notifications.ts](../src/notifications.ts). Sends email via nodemailer with:
- Primary recipient: `to: primaryEmail`
- CC recipients: `ccEmails` array (filtered to exclude primary)
- ICS file download link included in email body
- **Timezone handling**: Uses `event.timezone` for `toLocaleString()` or falls back to server default

### Email Parsing Feature
Route: `POST /event/:eventId/attendees/parse-emails` in [src/routes/attendees.ts](../src/routes/attendees.ts)
- Uses `addressparser` library to extract name/email from pasted email headers (e.g., "John Doe" <john@example.com>)
- Strips quotes/periods from names to create clean display names
- Default party size = 1 for all parsed attendees

## Development Workflow

### Local Development
```bash
npm install
npm run dev  # Uses nodemon to watch src/main.ts
```

Access at `http://localhost:3000`. Admin at `http://localhost:3000/admin`.

### Testing
```bash
npm test  # Runs Jest with ts-jest
```

Tests use in-memory SQLite (`process.env.DB_PATH = ':memory:'`) and import directly from modules (see [tests/server.test.ts](../tests/server.test.ts)).

### Building & Running Production
```bash
npm run build  # Compiles TS to dist/
npm start      # Runs dist/main.js
```

### Docker Deployment
```bash
docker build -t odette .
docker run -p 3000:3000 \
  -v /path/to/data:/data \
  -e SMTP_USER=... \
  -e SMTP_PASS=... \
  odette
```

The Dockerfile uses a two-stage build (builder + slim runtime). Database and uploaded banners persist in `/data` volume.

## Environment Variables

Required for production:
- `SMTP_USER`, `SMTP_PASS`: Gmail SMTP credentials for sending invites
- `SESSION_SECRET`: **Must** be a strong random string in production (default is insecure)

Optional:
- `PORT` (default: 3000)
- `APP_BASE_URL` (default: `http://localhost:3000`) — used for RSVP links in emails
- `DB_PATH` (default: `./rsvp.sqlite`, Docker default: `/data/rsvp.sqlite`)
- `EVENT_BANNER_STORAGE_PATH` (default: `./data/uploads/event-banners`, Docker: `/data/uploads/event-banners`)
- `NTFY_TOPIC`, `NTFY_BASE_URL`, `NTFY_USER`, `NTFY_PASS`: For push notifications on RSVPs

## Conventions & Patterns

### CSRF Protection
All `POST` routes use `csurf` middleware. Templates receive `csrfToken` and must include:
```html
<input type="hidden" name="_csrf" value="<%= csrfToken %>">
```

### Path Handling
Compiled code runs from `dist/`, so relative paths use `__dirname` carefully:
- Views: `path.join(__dirname, '../views')` → resolves to project root `/views`
- Static files: `path.join(__dirname, '../public')` → project root `/public`

### Date/Time Handling
- Store all timestamps as **JS milliseconds** (INTEGER in SQLite)
- Use `new Date(timestamp).getTime()` to convert user input
- For ICS files: Convert to UTC via `formatICSDate()` helper in [src/utils.ts](../src/utils.ts)
- For email display: Use `toLocaleString()` with `event.timezone` option

### HTML in Descriptions
Event descriptions can contain HTML (e.g., `<br>` tags). Use `htmlToPlainText()` helper in [src/utils.ts](../src/utils.ts) to:
1. Convert `<br>` and `<p>` to newlines
2. Strip all other HTML tags
3. Decode HTML entities (`&amp;`, `&lt;`, etc.)

### File Uploads (Multer)
Banner images upload to `EVENT_BANNER_STORAGE_PATH`:
- Max size: 5 MB
- Allowed types: JPEG, PNG, GIF
- Filenames: `event-{eventId}-{timestamp}.{ext}`
- Multer configuration in [src/server.ts](../src/server.ts)
- Upload handling in [src/routes/admin.ts](../src/routes/admin.ts)
- Old banners are **deleted** on update (see admin routes)

## Common Tasks

### Adding a New Event Field
1. Add column via runtime migration in `src/database.ts` (see `initializeDatabase()` function, `columnsToAddEvents` pattern)
2. Update `EventRecord` TypeScript type in `src/database.ts`
3. Add form input in [views/admin.ejs](../views/admin.ejs) and [views/event-admin.ejs](../views/event-admin.ejs)
4. Update INSERT/UPDATE queries in [src/routes/admin.ts](../src/routes/admin.ts)

### Adding a New Attendee Field
Follow the same pattern as above but for `attendees` table (see `last_modified` and `additional_emails` migrations as examples in `src/database.ts`).

### Modifying Email Templates
Email HTML is inline in `sendInvitation()` in [src/notifications.ts](../src/notifications.ts). Plain text version is auto-generated via `htmlToPlainText(html)`.

## Known Limitations (from TODO.md)

- No email queueing or rate limiting (sends are sequential)
- No structured logging (console.log only)
- No interactive RSVP editing (must click link again to change response)
- Party size locked after first RSVP submission
- Single admin user model (no multitenancy)

When implementing features, prefer simplicity over abstraction unless explicitly asked to refactor.
