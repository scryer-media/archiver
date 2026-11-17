import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export function engineVersion(directory) {
  return createHash('sha256').update(readFileSync(resolve(directory, 'archive-engine.js'))).update(readFileSync(resolve(directory, 'archive_engine.wasm'))).digest('hex').slice(0, 20);
}
