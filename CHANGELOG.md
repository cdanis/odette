# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-01-12

### Added
- Initial release of Odette - Event invitation and RSVP management system
- Token-based RSVP system with unique links for each guest
- Event management with date, location, description, and banner images
- Email invitation sending via Gmail SMTP with nodemailer
- Party size tracking for attendees
- Primary email + CC email addresses support for each attendee
- Batch import features:
  - Parse attendees from email headers
  - Upload CSV/TSV files
  - Copy attendees from other events
- Admin dashboard for event and attendee management
- ICS calendar file download for guests
- Timezone support using IANA timezone identifiers
- Push notifications via ntfy.sh for RSVP responses
- SQLite database with automatic runtime migrations
- Mobile and desktop responsive UI using PicoCSS
- Docker support with automatic image builds
- GitHub Actions CI/CD pipeline for testing and releases
- Comprehensive test suite with Jest
- TypeScript implementation with Express.js
- EJS server-side rendering
- No built-in authentication (designed for reverse proxy auth)

[0.1.0]: https://github.com/cdanis/odette/releases/tag/v0.1.0
