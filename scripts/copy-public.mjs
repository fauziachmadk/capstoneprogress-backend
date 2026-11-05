import { cp } from 'node:fs/promises';
import { URL } from 'node:url';
await cp(new URL('../public/', import.meta.url), new URL('../dist/public/', import.meta.url), { recursive: true });
