import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { loadConfig } from '../src/config.js';
let pending: ReturnType<typeof buildApp> | undefined;
export default async function handler(request: IncomingMessage, response: ServerResponse) {
  if (!pending) {
    const config = loadConfig();
    pending = buildApp({ db: createDatabase(config.DATABASE_URL), config, logger: true });
  }
  const app = await pending;
  app.server.emit('request', request, response);
}
