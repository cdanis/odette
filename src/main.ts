import app, { PORT, APP_BASE_URL } from './server';

app.listen(+PORT, (err?: Error) => {
    if (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
    console.log(`Server running at ${APP_BASE_URL}`);
});
