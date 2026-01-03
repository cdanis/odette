# v1
* DONE: convert rsvp.ejs
* TODO: convert event-admin.ejs
* DONE: convert thanks.ejs
* TODO: styled error pages

# MVP
* FEAT: last modified timestamp on attendees
* FEAT: interactive (htmlx) editing of events and attendees
  * debounce, replace
  * use same templates as pseudo-components
* FEAT: queueing of outgoing emails w/ ratelimit, backoff on failures
* FEAT: ntfy.sh events (or maybe, structured logging -> ntfy.sh ?)
* FEAT: download ICS file, from event + confirmation page
  * FEAT: structured metadata?
* FEAT: interactive (htmlx) rsvp'ing.



* does make build install everything in dist we need to?
* dockerfile



# other
* env vars loading or just lean on docker / systemd that's fine lol.

* should all the user-facing IDs be random strings instead of autoincrement ?

* restyle with bulma.  no! tailwind???



* alternate names?
  * quelle est demande (or similar) (what's the ask lol)
  * odette
  * papillon (🦋)



# out of scope
* multiple admin users / multitenancy
* any sort of oauth/login that isn't provided by reverse proxy just for /admin interface
