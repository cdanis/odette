// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2025 Chris Danis

// src/multer-config.ts
// Multer configuration for file uploads

import multer from 'multer';
import * as path from 'path';

const EVENT_BANNER_STORAGE_PATH = process.env.EVENT_BANNER_STORAGE_PATH || './data/uploads/event-banners';

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
  // Allow image files for banners
  if (file.fieldname === 'banner_image') {
    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png' || file.mimetype === 'image/gif') {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and GIF are allowed.'));
    }
  } 
  // Allow CSV/TSV files for attendee uploads
  else if (file.fieldname === 'csv_file') {
    if (file.mimetype === 'text/csv' || file.mimetype === 'text/tab-separated-values' || file.mimetype === 'text/plain') {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only CSV and TSV files are allowed.'));
    }
  } 
  else {
    cb(new Error('Unknown file field.'));
  }
};

export const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }
});

// Multer memory storage for CSV files (we need buffer access)
export const uploadMemory = multer({
  storage: multer.memoryStorage(),
  fileFilter: fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }
});
