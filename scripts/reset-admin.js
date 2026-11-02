// Lock-out recovery (docs/users.md): node scripts/reset-admin.js <username> <new password>
// Creates the account, or resets its password; either way it becomes an active administrator. Runs against the
// database in .env (PG* variables), so the server does not need to be running.
import { pool, one } from '../server/db/pool.js';
import { hashPassword } from '../server/services/auth.js';

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 8) {
  console.error('Usage: node scripts/reset-admin.js <username> <new password (8+ characters)>');
  process.exit(1);
}
try {
  const hash = await hashPassword(password);
  const u = await one(
    `UPDATE users SET password_hash = $2, role = 'admin', status = 'active', approved_at = coalesce(approved_at, now()), updated_at = now()
     WHERE lower(username) = lower($1) RETURNING username`, [username, hash])
    || await one(`INSERT INTO users(username, password_hash, role, status, approved_at) VALUES ($1, $2, 'admin', 'active', now()) RETURNING username`, [username, hash]);
  console.log(`${u.username} is an active administrator with the new password.`);
} finally {
  await pool.end();
}
