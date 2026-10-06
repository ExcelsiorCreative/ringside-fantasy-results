// Creates an API key for the fantasy app. Prints the key once and the SQL that stores its hash.
import { randomBytes, createHash } from 'node:crypto';
const label = process.argv[2] || 'fantasy-app';
const key = 'rs_' + randomBytes(24).toString('base64url');
const hash = createHash('sha256').update(key).digest('hex');
console.log(`API key (save it now, it is not stored anywhere):\n  ${key}\n`);
console.log(`Store it in the database:\n  npx wrangler@latest d1 execute ringside --remote --command "INSERT INTO api_keys(id,key_hash,label) VALUES('k_${Date.now()}','${hash}','${label.replace(/'/g, '')}')"`);
