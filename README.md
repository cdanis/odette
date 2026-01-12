# Odette

Event invitation and RSVP management system built for self-hosting.

## What it does

- Create events with details (date, location, description, banner images)
- Manage guest lists
- Send email invitations with unique RSVP links
- "Add to calendar" button yielding ICS calendar files
- Track responses (yes/no/pending)
- Optional push notifications (via ntfy.sh)

Each guest gets a unique link — no login required to RSVP.

## Features

- **Token-based RSVPs** — No guest logins, just click the link
- **Party size tracking** — Guests specify party size
- **Email handling** — Primary + CC addresses per attendee
- **Batch imports** — Parse from email headers, upload CSV/TSV, copy from other events
- **Admin dashboard** — Real-time statistics and searchable attendee management
- **ICS calendar downloads** — Unique calendar file per guest with event details
- **Timezone support** — Event times display correctly for all recipients
- **Event customization** — Banner images, location links, rich descriptions
- **Mobile-friendly and desktop-friendly UI** — Responsive design built with [PicoCSS](https://picocss.com/)
- **Zero-config database** — SQLite with automatic runtime migrations

## Self-Hosting

Odette is designed to be run on your own infrastructure. Admin routes (`/admin/*`) have **no built-in authentication** — they're meant to be protected by an authenticating reverse proxy (nginx, Caddy, oauth2-proxy, etc.).

Multi-tenancy / event admin logins are not currently implemented (see Roadmap).

## Quick Start

### Local Development

```bash
npm install
npm test
npm run dev
# Server runs at http://localhost:3000
# Auto-reloads on changes
```

Admin dashboard: `http://localhost:3000/admin`

### Production Build

```bash
npm ci
npm test
npm run build
npm start
```

### Docker

```bash
docker build -t odette .
docker run -p 3000:3000 \
  -v /path/to/data:/data \
  -e SMTP_USER=your-email@gmail.com \
  -e SMTP_PASS=your-app-password \
  -e SESSION_SECRET=random-secret-here \
  odette
```

Database and uploaded files persist in the `/data` volume.

## Configuration

Environment variables:

### Required for Email

- `SMTP_USER` — Gmail address for sending invites
- `SMTP_PASS` — Gmail app password ([create one](https://support.google.com/accounts/answer/185833))

### Required for Production

- `SESSION_SECRET` — Strong random string (default is insecure)

### Optional

- `PORT` (default: `3000`)
- `APP_BASE_URL` (default: `http://localhost:3000`) — Used in RSVP links
- `DB_PATH` (default: `./rsvp.sqlite` except in Docker where it's `/data/rsvp.sqlite`)
- `EVENT_BANNER_STORAGE_PATH` (default: `./data/uploads/event-banners` except in Docker where it's `/data/uploads/event-banners`)

### Optional: Push notifications for responses

- `NTFY_TOPIC` — Topic name for push notifications
- `NTFY_BASE_URL` (default: `https://ntfy.sh`)
- `NTFY_USER`, `NTFY_PASS` — Optional auth for private topics

## Reverse Proxy Authentication

Example nginx config with basic auth:

```nginx
location /admin {
    auth_basic "Admin Area";
    auth_basic_user_file /etc/nginx/.htpasswd;
    proxy_pass http://localhost:3000;
}

location / {
    proxy_pass http://localhost:3000;
}
```

Or use SSO solutions like Authelia, oauth2-proxy, etc.

## Tech Stack

- TypeScript + Express
- SQLite (better-sqlite3)
- EJS templates
- Nodemailer (Gmail SMTP)
- Pico CSS

## Testing

```bash
npm test
```

Tests use in-memory SQLite.

## Roadmap / Known Limitations

- No email queueing or rate limiting
- No multi-tenancy (single admin of all events per instance)
- No social login or SSO; admin auth is via reverse proxy only

See [TODO.md](TODO.md) for more.

## License

AGPL-3.0 — See [LICENSE.txt](LICENSE.txt)

## Contributing

This is primarily a personal project, but bug reports and PRs are welcome.

## AI Usage Disclosure

This project likely wouldn't exist without AI assistance. Lots of code and documentation were generated or improved using AI tools.