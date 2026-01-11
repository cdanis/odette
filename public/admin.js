// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2025 Chris Danis

// Admin Panel JavaScript

// ============================================================================
// Date Handling Utilities
// ============================================================================

/**
 * Format a Date object to YYYY-MM-DDTHH:MM for datetime-local input
 */
function formatDateToLocalInputString(date) {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

/**
 * Handle event form submission - convert local dates to UTC ISO strings
 */
function handleSubmitEventForm(event) {
  const form = event.target;
  const dateInput = form.querySelector('input[name="date"]');
  const dateEndInput = form.querySelector('input[name="date_end"]');

  if (dateInput && dateInput.value) {
    const localDate = new Date(dateInput.value);
    if (!isNaN(localDate.getTime())) {
      const hiddenUtcDateInput = document.createElement('input');
      hiddenUtcDateInput.type = 'hidden';
      hiddenUtcDateInput.name = 'date';
      hiddenUtcDateInput.value = localDate.toISOString();
      form.appendChild(hiddenUtcDateInput);
      dateInput.name = 'date_display';
    } else {
      dateInput.name = 'date_display_invalid';
    }
  } else if (dateInput) {
    dateInput.name = 'date_display_empty';
  }

  if (dateEndInput && dateEndInput.value) {
    const localDateEnd = new Date(dateEndInput.value);
    if (!isNaN(localDateEnd.getTime())) {
      const hiddenUtcDateEndInput = document.createElement('input');
      hiddenUtcDateEndInput.type = 'hidden';
      hiddenUtcDateEndInput.name = 'date_end';
      hiddenUtcDateEndInput.value = localDateEnd.toISOString();
      form.appendChild(hiddenUtcDateEndInput);
      dateEndInput.name = 'date_end_display';
    } else {
      dateEndInput.name = 'date_end_display_invalid';
    }
  } else if (dateEndInput) {
    dateEndInput.name = 'date_end_display_empty';
  }
}

// ============================================================================
// Confirmation Modal
// ============================================================================

/**
 * Show confirmation modal
 * @param {string} message - Confirmation message
 * @param {function} onConfirm - Callback when confirmed
 */
function showConfirmModal(message, onConfirm) {
  const modalHtml = `
    <div class="modal is-active" id="confirmModal">
      <div class="modal-background"></div>
      <div class="modal-card modal-confirm">
        <header class="modal-card-head">
          <p class="modal-card-title">Confirm Action</p>
          <button class="delete" aria-label="close" data-action="cancel"></button>
        </header>
        <section class="modal-card-body">
          <p>${message}</p>
        </section>
        <footer class="modal-card-foot">
          <button class="button is-danger" data-action="confirm">Confirm</button>
          <button class="button" data-action="cancel">Cancel</button>
        </footer>
      </div>
    </div>
  `;
  
  document.body.insertAdjacentHTML('beforeend', modalHtml);
  const modal = document.getElementById('confirmModal');
  
  modal.querySelector('[data-action="confirm"]').addEventListener('click', () => {
    modal.remove();
    onConfirm();
  });
  
  modal.querySelectorAll('[data-action="cancel"]').forEach(btn => {
    btn.addEventListener('click', () => modal.remove());
  });
  
  modal.querySelector('.modal-background').addEventListener('click', () => modal.remove());
}

// ============================================================================
// Document Ready
// ============================================================================

/**
 * Initialize datetime-local inputs from data-timestamp attributes
 */
function initializeDateInputs(form) {
  const dateInput = form.querySelector('input[name="date"]');
  const dateEndInput = form.querySelector('input[name="date_end"]');
  
  if (dateInput && dateInput.dataset.timestamp) {
    const timestamp = dateInput.dataset.timestamp;
    if (timestamp && timestamp !== 'null' && timestamp !== 'undefined' && !isNaN(Number(timestamp))) {
      dateInput.value = formatDateToLocalInputString(new Date(Number(timestamp)));
    }
  }
  
  if (dateEndInput && dateEndInput.dataset.timestamp) {
    const timestampEnd = dateEndInput.dataset.timestamp;
    if (timestampEnd && timestampEnd !== 'null' && timestampEnd !== 'undefined' && !isNaN(Number(timestampEnd))) {
      dateEndInput.value = formatDateToLocalInputString(new Date(Number(timestampEnd)));
    }
  }
}

document.addEventListener('DOMContentLoaded', function() {
  // Initialize event form date handlers
  const eventForms = document.querySelectorAll('#createEventForm, #editEventForm');
  eventForms.forEach(form => {
    if (form) {
      form.addEventListener('submit', handleSubmitEventForm);
      initializeDateInputs(form);
    }
  });

  // Display errors from URL query params
  const urlParams = new URLSearchParams(window.location.search);
  const error = urlParams.get('error');
  if (error && !document.querySelector('.form-section p[style="color: red;"]')) {
    const errorP = document.createElement('p');
    errorP.style.color = 'red';
    errorP.textContent = decodeURIComponent(error);
    const formSectionH2 = document.querySelector('.form-section h2') || document.querySelector('.form-section h3');
    if (formSectionH2 && formSectionH2.parentNode) {
      formSectionH2.parentNode.insertBefore(errorP, formSectionH2.nextSibling);
    }
  }

  // Bulk send invites confirmation
  const bulkSendForm = document.querySelector('form[action*="/send-invites"]');
  if (bulkSendForm) {
    bulkSendForm.addEventListener('submit', function(e) {
      const button = this.querySelector('button[type="submit"]');
      if (!button.disabled) {
        e.preventDefault();
        const eventTitle = document.querySelector('h1').textContent.replace('Manage Event: ', '');
        showConfirmModal(
          `Are you sure you want to send all pending invitations for "${eventTitle}"? This action cannot be undone.`,
          () => this.submit()
        );
      }
    });
  }

  // Delete attendee confirmation (using event delegation for DataTables)
  document.addEventListener('submit', function(e) {
    const form = e.target;
    if (form && form.classList && form.classList.contains('delete-attendee-form')) {
      e.preventDefault();
      e.stopPropagation();
      const row = form.closest('tr');
      const attendeeName = row ? row.querySelector('td:first-child').textContent.trim() : '';
      const confirmMessage = attendeeName 
        ? `Are you sure you want to delete attendee "${attendeeName}"? This action cannot be undone.`
        : 'Are you sure you want to delete this attendee? This action cannot be undone.';
      
      showConfirmModal(confirmMessage, () => {
        // Create a new form submission to avoid event loop issues
        const newForm = document.createElement('form');
        newForm.method = form.method;
        newForm.action = form.action;
        Array.from(form.elements).forEach(element => {
          if (element.name) {
            const input = document.createElement('input');
            input.type = 'hidden';
            input.name = element.name;
            input.value = element.value;
            newForm.appendChild(input);
          }
        });
        document.body.appendChild(newForm);
        newForm.submit();
      });
    }
  });
});
