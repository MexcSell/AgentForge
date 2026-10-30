import { one, query } from '../db/pool.js';
import { emit } from '../events.js';

export async function notify({ source_type = 'system', source_name = 'System', agent_id = null, project_id = null, level = 'info', title, body = null }) {
  const row = await one(
    `INSERT INTO notifications(source_type, source_name, agent_id, project_id, level, title, body)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [source_type, source_name, agent_id, project_id, level, title, body],
  );
  emit('notification:new', row);
  return row;
}

export async function audit(actor, action, target, detail = {}) {
  await query(`INSERT INTO audit_logs(actor, action, target, detail) VALUES ($1,$2,$3,$4)`, [actor, action, target, detail]).catch(() => {});
}
