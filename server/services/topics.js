import { one, many, query } from '../db/pool.js';
import { emit } from '../events.js';

// A project's chat is a set of topic threads. WebSocket contract:
// topic:new (full row) · topic:update (full row) · topic:delete { id, project_id } · topic:moved (emitted by the engine).

// running = the topic has a planning or running mission.
const TOPIC_COLS = `t.*,
  (SELECT count(*)::int FROM messages m WHERE m.topic_id = t.id) AS message_count,
  EXISTS (SELECT 1 FROM missions s WHERE s.topic_id = t.id AND s.status IN ('planning', 'running')) AS running`;

export const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const cleanTitle = (title) => String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);

// At most 5 unique, lowercase tags of 24 chars or fewer. Accepts an array or a comma-separated string.
export function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',') : [];
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const tag = String(raw).trim().replace(/^#+/, '').replace(/\s+/g, '-').toLowerCase().slice(0, 24);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length === 5) break;
  }
  return out;
}

export async function listTopics(projectId) {
  return many(`SELECT ${TOPIC_COLS} FROM topics t WHERE t.project_id = $1 ORDER BY t.archived, t.last_activity_at DESC`, [projectId]);
}

export async function getTopic(id) {
  if (!isUuid(id)) return null;
  return one(`SELECT ${TOPIC_COLS} FROM topics t WHERE t.id = $1`, [id]);
}

export async function publishTopic(id) {
  const t = await getTopic(id);
  if (t) emit('topic:update', t);
  return t;
}

// Does not emit: callers send topic:new themselves (the engine adds moved_from / mission_id).
export async function createTopic({ project_id, title, tags, title_locked = false }) {
  const row = await one(
    `INSERT INTO topics(project_id, title, tags, title_locked) VALUES ($1,$2,$3,$4) RETURNING id`,
    [project_id, cleanTitle(title) || 'New topic', JSON.stringify(normalizeTags(tags)), !!title_locked],
  );
  return getTopic(row.id);
}

// Only the given fields change; emits topic:update with the full row.
export async function updateTopic(id, { title, tags, archived, title_locked } = {}) {
  const t = await getTopic(id);
  if (!t) return null;
  await query(
    `UPDATE topics SET title=$2, tags=$3, archived=$4, title_locked=$5, updated_at=now() WHERE id=$1`,
    [t.id, (title !== undefined && cleanTitle(title)) || t.title, JSON.stringify(tags === undefined ? t.tags : normalizeTags(tags)),
      archived === undefined ? t.archived : !!archived, title_locked === undefined ? t.title_locked : !!title_locked],
  );
  return publishTopic(t.id);
}

// Messages cascade; missions keep their history with topic_id set to NULL. Emits topic:delete.
export async function deleteTopic(id) {
  if (!isUuid(id)) return null;
  const row = await one(`DELETE FROM topics WHERE id = $1 RETURNING id, project_id`, [id]);
  if (row) emit('topic:delete', { id: row.id, project_id: row.project_id });
  return row;
}

export async function touchTopic(id) {
  if (!isUuid(id)) return;
  await query(`UPDATE topics SET last_activity_at = now() WHERE id = $1`, [id]);
}

// The requested topic if it belongs to the project, else the most recent open one, else a fresh 'New topic' (emits topic:new).
export async function ensureTopic(projectId, topicId = null) {
  if (isUuid(topicId)) {
    const t = await one(`SELECT ${TOPIC_COLS} FROM topics t WHERE t.id = $1 AND t.project_id = $2`, [topicId, projectId]);
    if (t) return t;
  }
  const recent = await one(`SELECT ${TOPIC_COLS} FROM topics t WHERE t.project_id = $1 AND NOT t.archived ORDER BY t.last_activity_at DESC LIMIT 1`, [projectId]);
  if (recent) return recent;
  const t = await createTopic({ project_id: projectId });
  emit('topic:new', t);
  return t;
}
