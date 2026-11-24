// Decrypt a GitHub backup file to plain JSON, e.g. for offline inspection or
// a manual restore elsewhere:
//   BACKUP_ENCRYPTION_KEY=... node scripts/decrypt-backup.mjs latest.enc > backup.json
import fs from 'node:fs';
import zlib from 'node:zlib';
import { decrypt } from '../server/src/backup.js';

const [file] = process.argv.slice(2);
if (!file || !process.env.BACKUP_ENCRYPTION_KEY) {
  console.error('Usage: BACKUP_ENCRYPTION_KEY=... node scripts/decrypt-backup.mjs <file.enc>');
  process.exit(1);
}
const json = zlib.gunzipSync(decrypt(fs.readFileSync(file), process.env.BACKUP_ENCRYPTION_KEY));
process.stdout.write(json);
