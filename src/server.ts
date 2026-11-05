import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
const app = await buildApp({ db, config, logger: true, closeDatabaseOnClose: true });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });
await app.listen({ port: config.PORT, host: config.HOST });
