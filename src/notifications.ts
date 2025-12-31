// src/notifications.ts
// Email and notification handling

import * as nodemailer from 'nodemailer';
import { htmlToPlainText } from './utils';
import type { EventRecord } from './database';

// ============================================================================
// Configuration
// ============================================================================

const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const NTFY_BASE_URL = (process.env.NTFY_BASE_URL ?? 'https://ntfy.sh').replace(/\/+$/, '');
const NTFY_USER = process.env.NTFY_USER;
const NTFY_PASS = process.env.NTFY_PASS;

// ============================================================================
// Email Transporter
// ============================================================================

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});

// ============================================================================
// Functions
// ============================================================================

/**
 * Send an event invitation email
 * 
 * @param name Recipient's name
 * @param primaryEmail Primary recipient email
 * @param ccEmails Array of CC email addresses (will be filtered to exclude primary)
 * @param token Unique RSVP token
 * @param event Event details
 * @param appBaseUrl Base URL for generating RSVP links
 */
export async function sendInvitation(
  name: string, 
  primaryEmail: string, 
  ccEmails: string[], 
  token: string, 
  event: EventRecord,
  appBaseUrl: string
): Promise<void> {
  const rsvpLink = `${appBaseUrl}/rsvp/${token}`;
  const icsLink = `${appBaseUrl}/ics/${token}`;

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

/**
 * Send push notification to admin via ntfy.sh
 * 
 * @param att Attendee data (must include name and event_title)
 * @param rsvp RSVP response ('yes' or 'no')
 * @param partySize Party size
 */
export async function notifyAdmin(att: any, rsvp: string, partySize: number): Promise<void> {
  if (!NTFY_TOPIC) return;
  
  const title = `RSVP: ${att.name}`;
  const msg = `Event: ${att.event_title}\nResponse: ${rsvp}\nParty Size: ${partySize}`;
  const headers: Record<string, string> = { 'Title': title };
  
  if (NTFY_USER && NTFY_PASS) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${NTFY_USER}:${NTFY_PASS}`).toString('base64');
  }
  
  try {
    await fetch(`${NTFY_BASE_URL}/${NTFY_TOPIC}`, { method: 'POST', headers, body: msg });
  } catch (e) {
    console.error('ntfy error', e);
  }
}
