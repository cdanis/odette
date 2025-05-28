import { app, PORT, APP_BASE_URL } from './server';

app.listen(+PORT, () => console.log(`Server running at ${APP_BASE_URL}`));
