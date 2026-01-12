# v0
* TODO: minimal footer? + about page?
* TODO: delete events
* FEAT: csv/json export of attendees + responses


# v1
* FEAT: multi-user
  * users table
  * users<>event permissions join table?
  * passportjs social logins?  webauthn?
* FEAT: interactive (htmlx) editing of events and attendees
  * debounce, replace
  * use same templates as pseudo-components
* FEAT: queueing of outgoing emails w/ ratelimit, backoff on failures
* FEAT: interactive (htmlx) rsvp'ing.
* FEAT: can we use oauth2 to send via gmail api?
* FEAT: support other email providers
* FEAT: some other themeing options, maybe a small library of stock images?
* FEAT: better logging (winston?)
