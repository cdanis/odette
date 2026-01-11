// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2025 Chris Danis

// Admin Panel JavaScript

// ============================================================================
// Date Handling Utilities
// ============================================================================

/**
 * Format a timestamp to YYYY-MM-DDTHH:MM for datetime-local input in a specific timezone
 * @param {number} timestamp - JS timestamp in milliseconds
 * @param {string} timezone - IANA timezone name
 * @returns {string} datetime-local formatted string
 */
function formatDateToLocalInputString(timestamp, timezone) {
  // Convert timestamp to date in the event's timezone
  const date = new Date(timestamp);
  
  // Get the date/time components in the event's timezone
  const options = { 
    year: 'numeric', 
    month: '2-digit', 
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone
  };
  
  const formatter = new Intl.DateTimeFormat('en-CA', options);
  const parts = formatter.formatToParts(date);
  
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  const hour = parts.find(p => p.type === 'hour').value;
  const minute = parts.find(p => p.type === 'minute').value;
  
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

/**
 * Initialize datetime-local inputs from data-timestamp attributes
 * Uses the event's timezone if available
 */
function initializeDateInputs(form) {
  const dateInput = form.querySelector('input[name="date"]');
  const dateEndInput = form.querySelector('input[name="date_end"]');
  const timezoneSelect = form.querySelector('select[name="timezone"]');
  
  // Get the event's timezone, fallback to browser timezone
  const timezone = timezoneSelect?.value || Intl.DateTimeFormat().resolvedOptions().timeZone;
  
  if (dateInput && dateInput.dataset.timestamp) {
    const timestamp = dateInput.dataset.timestamp;
    if (timestamp && timestamp !== 'null' && timestamp !== 'undefined' && !isNaN(Number(timestamp))) {
      dateInput.value = formatDateToLocalInputString(Number(timestamp), timezone);
    }
  }
  
  if (dateEndInput && dateEndInput.dataset.timestamp) {
    const timestampEnd = dateEndInput.dataset.timestamp;
    if (timestampEnd && timestampEnd !== 'null' && timestampEnd !== 'undefined' && !isNaN(Number(timestampEnd))) {
      dateEndInput.value = formatDateToLocalInputString(Number(timestampEnd), timezone);
    }
  }
}
