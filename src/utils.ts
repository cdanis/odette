// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2025 Chris Danis

// src/utils.ts
// Pure utility functions with no dependencies on Express or database

import * as crypto from 'crypto';

/**
 * Generate a cryptographically secure random token for RSVP links
 * @returns 32-character hex string
 */
export function generateToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Validate that a token is a valid 32-character hex string
 * @param token Token to validate
 * @returns True if token matches the valid format
 */
export function isValidToken(token: string): boolean {
  return /^[0-9a-f]{32}$/.test(token);
}

/**
 * Format a JavaScript timestamp to ICS UTC date-time string
 * @param timestamp JS timestamp in milliseconds
 * @returns ICS-formatted date string (e.g., "20250101T120000Z")
 */
export function formatICSDate(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (num: number) => num.toString().padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/**
 * Escape text for ICS file format and optionally convert HTML to plain text
 * @param text Text to escape
 * @param isHtmlContent If true, strips HTML tags and decodes entities first
 * @returns Escaped text suitable for ICS files
 */
export function escapeICSText(text: string | null | undefined, isHtmlContent: boolean = false): string {
  if (text === null || typeof text === 'undefined') return '';

  let processedText = String(text); // Ensure it's a string

  if (isHtmlContent) {
    // 1. Convert <br> tags to newlines
    processedText = processedText.replace(/<br\s*\/?>/gi, '\n');
    // 2. Strip all other HTML tags
    processedText = processedText.replace(/<[^>]+>/g, '');
    // 3. Decode common HTML entities
    // Order is important: &amp; first
    processedText = processedText.replace(/&amp;/g, '&')
                                 .replace(/&lt;/g, '<')
                                 .replace(/&gt;/g, '>')
                                 .replace(/&quot;/g, '"')
                                 .replace(/&#039;/g, "'") // Numeric entity for single quote
                                 .replace(/&apos;/g, "'") // Named entity for single quote
                                 .replace(/&nbsp;/g, ' '); // Non-breaking space to space
    // 4. Trim whitespace that might be left around after stripping tags
    processedText = processedText.trim();
  }

  // Escape characters for ICS format
  return processedText
    .replace(/\\/g, '\\\\') // Must be first: escape backslashes
    .replace(/\r/g, '')     // Remove carriage returns
    .replace(/\n/g, '\\n')  // Escape newlines (convert LF to literal \n)
    .replace(/,/g, '\\,')   // Escape commas
    .replace(/;/g, '\\;');  // Escape semicolons
}

/**
 * Convert HTML to plain text for email bodies
 * Handles common HTML tags and entities
 * @param html HTML content
 * @returns Plain text version
 */
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return '';
  let text = String(html);
  // Convert <br> and <p> tags to newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>\s*<p>/gi, '\n\n'); // Convert paragraph breaks to double newlines
  // Strip all other HTML tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&quot;/g, '"')
             .replace(/&#039;/g, "'")
             .replace(/&apos;/g, "'")
             .replace(/&nbsp;/g, ' '); // Non-breaking space to space
  return text.trim();
}

/**
 * Get IANA timezone list with fallback for older Node versions
 * @returns Array of IANA timezone names
 */
export function getTimezones(): string[] {
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function') {
      return Intl.supportedValuesOf('timeZone');
    } else {
      throw new Error("Intl.supportedValuesOf('timeZone') is not available.");
    }
  } catch (e) {
    console.warn("Could not get IANA timezones using Intl.supportedValuesOf('timeZone'). Using a fallback list.", e);
    return [ // Basic fallback list
      'UTC', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 
      'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
      'Asia/Tokyo', 'Asia/Dubai', 'Asia/Kolkata', 'Australia/Sydney',
    ];
  }
}

/**
 * Derive a display name from a parsed email address
 * If a name is provided, use it; otherwise derive from email username
 * Strips periods, quotes, and apostrophes from derived names
 * 
 * @param parsedAddress Object with optional name and address fields
 * @returns Derived display name
 */
export function deriveNameFromEmail(parsedAddress: { name?: string; address?: string }): string {
  if (parsedAddress.name) {
    return parsedAddress.name;
  }
  
  if (!parsedAddress.address) {
    return '';
  }
  
  const email = parsedAddress.address;
  const atIndex = email.lastIndexOf('@');
  
  if (atIndex === -1) {
    return email; // Malformed email, return as-is
  }
  
  // Extract username part and clean it up
  return email
    .substring(0, atIndex)
    .replace(/[."']/g, ' ')
    .trim();
}

/**
 * Parse a single line from a CSV or TSV file
 * Automatically detects delimiter and extracts email and name
 * 
 * @param line Single line from CSV/TSV file
 * @returns Object with email, name, and party_size (based on number of emails), or null if no email found
 */
export function parseCsvTsvLine(line: string): { email: string; name: string; party_size: number } | null {
  if (!line || !line.trim()) {
    return null;
  }

  // Detect delimiter (tab or comma)
  const delimiter = line.includes('\t') ? '\t' : ',';
  
  // Parse CSV/TSV respecting quotes
  const columns: string[] = [];
  let currentColumn = '';
  let inQuotes = false;
  let quoteChar: string | null = null;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (!inQuotes && (char === '"' || char === "'")) {
      // Start of quoted field
      inQuotes = true;
      quoteChar = char;
    } else if (inQuotes && char === quoteChar) {
      // End of quoted field
      inQuotes = false;
      quoteChar = null;
    } else if (!inQuotes && char === delimiter) {
      // Field separator
      columns.push(currentColumn.trim());
      currentColumn = '';
    } else {
      // Regular character
      currentColumn += char;
    }
  }
  
  // Add the last column
  columns.push(currentColumn.trim());
  
  // Simple email regex for column detection
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  
  let email: string | null = null;
  let name: string | null = null;
  let emailCount = 0;
  
  // Count all email columns and get first one
  for (const col of columns) {
    if (col && emailRegex.test(col)) {
      emailCount++;
      if (!email) {
        email = col;
      }
    }
  }
  
  if (!email) {
    return null;
  }
  
  // Find first non-email column for name
  for (const col of columns) {
    if (col && !emailRegex.test(col)) {
      name = col;
      break;
    }
  }
  
  // Use derived name if no name column found
  const finalName = name || deriveNameFromEmail({ address: email });
  
  return { email, name: finalName, party_size: emailCount };
}
