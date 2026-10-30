// Connectivity check from design.md: `npm run db:check`
import { pool } from './pool.js';

const result = await pool.query('SELECT NOW()');
console.log(result.rows);
await pool.end();
