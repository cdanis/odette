// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2025 Chris Danis

import app, { PORT, APP_BASE_URL } from './server';

app.listen(+PORT, (err?: Error) => {
    if (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
    console.log(`Server running at ${APP_BASE_URL}`);
});
