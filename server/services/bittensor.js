// Bittensor competition watcher: polls a competition source (subtensor chain RPC, the bittensor Python SDK, a JSON
// feed URL or a local JSON file), records every competition it sees in bt_competitions once, and for each new one
// creates a 'miner' agent ("Mino") with a task describing it, notifies the UI and runs the submission step.
//
// Config: config/bittensor.json (non-secret) and config/bittensor.secrets.json (wallet + API keys), both gitignored;
// see the *.example.json templates and the README. Missing, empty, invalid or disabled config leaves the watcher inert.
// Submission runs only when enabled && autoSubmit && !dryRun && wallet keys are present; otherwise it is recorded as a
// dry run. The watcher never throws into the server: every failure is logged and kept in status().lastError.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from '../config.js';
import { one, many, query } from '../db/pool.js';
import { emit } from '../events.js';
import { createAgent } from './agents.js';
import { notify, audit } from './notify.js';

export const CONFIG_PATH = path.join(ROOT, 'config', 'bittensor.json');
export const SECRETS_PATH = path.join(ROOT, 'config', 'bittensor.secrets.json');

export const NETWORKS = {
  finney: 'https://entrypoint-finney.opentensor.ai:443',
  test: 'https://test.finney.opentensor.ai:443',
  local: 'http://127.0.0.1:9944',
};
const SOURCES = ['rpc', 'sdk', 'feed', 'file'];
const INERT_RECHECK_SEC = 60; // how often an inert watcher looks at its config files again
const FETCH_TIMEOUT_MS = 15000;
const HELPER_TIMEOUT_MS = 60000;
const MAX_OUTPUT = 8000;

export const DEFAULTS = {
  enabled: false,
  network: 'finney',
  endpoint: '',
  pollIntervalSec: 300,
  sources: ['rpc'],
  feed: { url: '' },
  file: { path: '' },
  sdk: { python: 'python3', script: 'scripts/bittensor/list_subnets.py' },
  subnets: { include: [], exclude: [] },
  baselineOnFirstRun: true,
  autoSubmit: false,
  dryRun: true,
  submit: { command: ['bash', 'scripts/bittensor/submit.sh'], timeoutSec: 900 },
};

// ---- config -----------------------------------------------------------------------------------------------------

function readJson(file) {
  if (!fs.existsSync(file)) return { missing: true };
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return { empty: true };
  const value = JSON.parse(text); // throws on bad JSON; the caller reports it
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('top level must be a JSON object');
  return { value };
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const netuids = (v) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n >= 0) : []);

/** Merge a parsed config over DEFAULTS and validate it; throws with a readable message when it can not be used. */
export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULTS, ...raw };
  const network = str(c.network) || 'finney';
  const sources = (Array.isArray(c.sources) ? c.sources : [c.sources]).map(str).filter(Boolean);
  const bad = sources.filter((s) => !SOURCES.includes(s));
  if (bad.length) throw new Error(`unknown source ${bad.join(', ')} (use ${SOURCES.join(' | ')})`);
  if (!sources.length) throw new Error('no competition source configured (sources is empty)');
  const endpoint = str(c.endpoint) || NETWORKS[network] || '';
  if (sources.includes('rpc') && !endpoint) throw new Error(`no endpoint for network "${network}" (set endpoint)`);
  const feed = { ...DEFAULTS.feed, ...c.feed };
  if (sources.includes('feed') && !str(feed.url)) throw new Error('source "feed" needs feed.url');
  const file = { ...DEFAULTS.file, ...c.file };
  if (sources.includes('file') && !str(file.path)) throw new Error('source "file" needs file.path');
  const submit = { ...DEFAULTS.submit, ...c.submit };
  const command = typeof submit.command === 'string' ? ['sh', '-c', submit.command] : submit.command;
  if (!Array.isArray(command) || !command.length || command.some((x) => typeof x !== 'string')) throw new Error('submit.command must be a string or an array of strings');
  return {
    enabled: c.enabled === true,
    network,
    endpoint,
    pollIntervalSec: Math.max(30, Number(c.pollIntervalSec) || DEFAULTS.pollIntervalSec),
    sources,
    feed: { url: str(feed.url) },
    file: { path: str(file.path) },
    sdk: { python: str(c.sdk?.python) || DEFAULTS.sdk.python, script: str(c.sdk?.script) || DEFAULTS.sdk.script },
    subnets: { include: netuids(c.subnets?.include), exclude: netuids(c.subnets?.exclude) },
    baselineOnFirstRun: c.baselineOnFirstRun !== false,
    autoSubmit: c.autoSubmit === true,
    dryRun: c.dryRun !== false,
    submit: { command, timeoutSec: Math.max(10, Number(submit.timeoutSec) || DEFAULTS.submit.timeoutSec) },
  };
}

export function normalizeSecrets(raw = {}) {
  const w = raw.wallet || {};
  return {
    wallet: {
      name: str(w.name), hotkey: str(w.hotkey), path: str(w.path),
      coldkeyPath: str(w.coldkeyPath), coldkeyMnemonic: str(w.coldkeyMnemonic), coldkeyPassword: str(w.coldkeyPassword),
    },
    apiKeys: Object.fromEntries(Object.entries(raw.apiKeys || {}).map(([k, v]) => [k, str(v)])),
  };
}

// Wallet name + hotkey are the minimum btcli needs to register; the coldkey itself lives in the wallet directory.
export const keysPresent = (secrets) => !!(secrets?.wallet?.name && secrets?.wallet?.hotkey);

/**
 * Load both files. Returns { config, secrets, inert } where inert is a reason string when the watcher must stay idle
 * (missing/empty/invalid config, or enabled !== true). Never throws. Secrets problems never make it inert: they only
 * keep submission off.
 */
export function loadSettings({ configPath = CONFIG_PATH, secretsPath = SECRETS_PATH } = {}) {
  const rel = (p) => path.relative(ROOT, p) || p;
  let config = null, inert = null, secrets = normalizeSecrets(), secretsError = null;
  try {
    const r = readJson(configPath);
    if (r.missing) inert = `${rel(configPath)} not found`;
    else if (r.empty) inert = `${rel(configPath)} is empty`;
    else {
      config = normalizeConfig(r.value);
      if (!config.enabled) inert = `disabled in ${rel(configPath)} (enabled is not true)`;
    }
  } catch (e) {
    config = null;
    inert = `bad config ${rel(configPath)}: ${e.message}`;
  }
  try {
    const r = readJson(secretsPath);
    if (r.value) secrets = normalizeSecrets(r.value);
  } catch (e) {
    secretsError = `bad secrets ${rel(secretsPath)}: ${e.message}`;
  }
  return { config, secrets, inert, secretsError };
}

/** Why a submission would not run right now, or [] when it is armed. */
export function submitBlockers(config, secrets) {
  const why = [];
  if (!config?.enabled) why.push('watcher disabled');
  if (!config?.autoSubmit) why.push('autoSubmit is off');
  if (config?.dryRun !== false) why.push('dryRun is on');
  if (!keysPresent(secrets)) why.push('wallet keys missing');
  return why;
}

// ---- twox128 (xxHash64) for substrate storage keys ----------------------------------------------------------------

const M64 = (1n << 64n) - 1n;
const P1 = 11400714785074694791n, P2 = 14029467366897019727n, P3 = 1609587929392839161n, P4 = 9650029242287828579n, P5 = 2870177450012600261n;
const rotl = (x, r) => ((x << BigInt(r)) | (x >> BigInt(64 - r))) & M64;
const xxRound = (acc, v) => (rotl((acc + v * P2) & M64, 31) * P1) & M64;
const xxMerge = (acc, v) => ((((acc ^ xxRound(0n, v)) * P1) & M64) + P4) & M64;

export function xxh64(buf, seed = 0n) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const len = buf.length;
  let i = 0, h;
  if (len >= 32) {
    let v1 = (seed + P1 + P2) & M64, v2 = (seed + P2) & M64, v3 = seed, v4 = (seed - P1) & M64;
    for (; i + 32 <= len; i += 32) {
      v1 = xxRound(v1, dv.getBigUint64(i, true)); v2 = xxRound(v2, dv.getBigUint64(i + 8, true));
      v3 = xxRound(v3, dv.getBigUint64(i + 16, true)); v4 = xxRound(v4, dv.getBigUint64(i + 24, true));
    }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) & M64;
    h = xxMerge(xxMerge(xxMerge(xxMerge(h, v1), v2), v3), v4);
  } else h = (seed + P5) & M64;
  h = (h + BigInt(len)) & M64;
  for (; i + 8 <= len; i += 8) h = (((rotl(h ^ xxRound(0n, dv.getBigUint64(i, true)), 27) * P1) & M64) + P4) & M64;
  for (; i + 4 <= len; i += 4) h = (((rotl(h ^ ((BigInt(dv.getUint32(i, true)) * P1) & M64), 23) * P2) & M64) + P3) & M64;
  for (; i < len; i++) h = (rotl(h ^ ((BigInt(buf[i]) * P5) & M64), 11) * P1) & M64;
  h ^= h >> 33n; h = (h * P2) & M64; h ^= h >> 29n; h = (h * P3) & M64; h ^= h >> 32n;
  return h;
}

const le64 = (h) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(h); return b.toString('hex'); };
export const twox128 = (s) => { const b = Buffer.from(s); return le64(xxh64(b, 0n)) + le64(xxh64(b, 1n)); };
export const storagePrefix = (pallet, item) => `0x${twox128(pallet)}${twox128(item)}`;

// ---- competition sources ------------------------------------------------------------------------------------------

/** Normalize one feed/file/sdk entry to { external_id, netuid, name, registered_block, detail }, or null if unusable. */
export function toCompetition(x) {
  if (!x || typeof x !== 'object') return null;
  const netuid = Number.isInteger(Number(x.netuid)) && x.netuid !== null && x.netuid !== '' ? Number(x.netuid) : null;
  const block = x.registered_block ?? x.registeredBlock ?? x.network_registered_at ?? null;
  const registered_block = block === null || block === '' || !Number.isFinite(Number(block)) ? null : Number(block);
  const id = str(String(x.id ?? ''));
  if (!id && netuid === null) return null;
  return {
    external_id: id ? `id:${id}` : `subnet:${netuid}@${registered_block ?? 0}`,
    netuid,
    name: str(x.name) || str(x.title) || (netuid !== null ? `Subnet ${netuid}` : id),
    registered_block,
    detail: Object.fromEntries(Object.entries(x).filter(([k]) => ['url', 'description', 'owner', 'starts_at', 'ends_at', 'reward', 'symbol'].includes(k))),
  };
}

const listFrom = (data) => (Array.isArray(data) ? data : Array.isArray(data?.competitions) ? data.competitions : Array.isArray(data?.subnets) ? data.subnets : null);

function parseList(data, what) {
  const list = listFrom(data);
  if (!list) throw new Error(`${what} did not return a JSON array (or { competitions: [...] })`);
  return list.map(toCompetition).filter(Boolean);
}

const httpEndpoint = (url) => url.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');

async function rpc(endpoint, method, params, signal) {
  let res;
  try {
    res = await fetch(httpEndpoint(endpoint), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
    });
  } catch (e) {
    throw new Error(`RPC ${httpEndpoint(endpoint)} unreachable: ${e.cause?.message || e.message}`);
  }
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!body) throw new Error(`RPC ${method}: invalid JSON response`);
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message || JSON.stringify(body.error)}`);
  return body.result;
}

const NETWORKS_ADDED = storagePrefix('SubtensorModule', 'NetworksAdded');
const REGISTERED_AT = storagePrefix('SubtensorModule', 'NetworkRegisteredAt');
const u64le = (hex) => (hex && /^0x[0-9a-f]{16}$/i.test(hex) ? Number(Buffer.from(hex.slice(2), 'hex').readBigUInt64LE()) : null);

/**
 * Subnets from chain state: the keys of SubtensorModule.NetworksAdded (value true) give the netuids (u16 LE at the key's
 * end); NetworkRegisteredAt under the same key suffix gives the registration block, so a netuid re-registered later
 * counts as a new competition.
 */
async function rpcSource(cfg, signal) {
  const keys = [];
  for (let start = null; ;) {
    const page = await rpc(cfg.endpoint, 'state_getKeysPaged', [NETWORKS_ADDED, 1000, start], signal);
    if (!Array.isArray(page)) throw new Error('RPC state_getKeysPaged: unexpected result');
    keys.push(...page);
    if (page.length < 1000) break;
    start = page[page.length - 1];
  }
  if (!keys.length) return [];
  const suffixes = keys.map((k) => k.slice(NETWORKS_ADDED.length));
  const regKeys = suffixes.map((s) => REGISTERED_AT + s);
  const sets = await rpc(cfg.endpoint, 'state_queryStorageAt', [[...keys, ...regKeys]], signal);
  const values = new Map();
  for (const set of Array.isArray(sets) ? sets : []) for (const [k, v] of set.changes || []) values.set(k, v);
  const out = [];
  keys.forEach((k, i) => {
    if (values.has(k) && values.get(k) !== '0x01') return; // present but false: not an active subnet
    const hex = k.slice(-4);
    const netuid = parseInt(hex.slice(0, 2), 16) + parseInt(hex.slice(2, 4), 16) * 256;
    out.push(toCompetition({ netuid, registered_block: u64le(values.get(regKeys[i])) ?? 0 }));
  });
  return out;
}

async function feedSource(cfg, secrets, signal) {
  const key = secrets.apiKeys?.feed;
  let res;
  try {
    res = await fetch(cfg.feed.url, { headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) });
  } catch (e) {
    throw new Error(`feed ${cfg.feed.url} unreachable: ${e.cause?.message || e.message}`);
  }
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  return parseList(await res.json().catch(() => { throw new Error('feed returned invalid JSON'); }), 'feed');
}

function fileSource(cfg) {
  const file = path.resolve(ROOT, cfg.file.path);
  if (!fs.existsSync(file)) throw new Error(`source file ${cfg.file.path} not found`);
  const text = fs.readFileSync(file, 'utf8');
  return text.trim() ? parseList(JSON.parse(text), `file ${cfg.file.path}`) : [];
}

/**
 * Run argv in its own process group, killed on timeout or abort. Resolves { code, output, timedOut, aborted, error };
 * never rejects.
 */
export function runCommand(argv, { env = {}, timeoutMs, signal, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    let output = '', timedOut = false, aborted = false, done = false;
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: null, output: '', error: e.message });
    }
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } };
    const add = (d) => { if (output.length < 4 * MAX_OUTPUT) output += d; };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => { aborted = true; kill(); };
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ output, timedOut, aborted, ...r });
    };
    child.on('error', (e) => finish({ code: null, error: e.message }));
    child.on('close', (code) => finish({ code }));
  });
}

async function sdkSource(cfg, signal) {
  const script = path.resolve(ROOT, cfg.sdk.script);
  const r = await runCommand([cfg.sdk.python, script, '--network', cfg.network, ...(cfg.endpoint ? ['--endpoint', cfg.endpoint] : [])], { timeoutMs: HELPER_TIMEOUT_MS, signal });
  if (r.error) throw new Error(`sdk helper failed to start: ${r.error}`);
  if (r.code !== 0) throw new Error(`sdk helper exited ${r.timedOut ? 'on timeout' : r.code}: ${r.output.trim().split('\n').slice(-3).join(' | ')}`);
  const last = r.output.trim().split('\n').filter(Boolean).pop() || '[]';
  try {
    return parseList(JSON.parse(last), 'sdk helper');
  } catch (e) {
    throw new Error(`sdk helper output: ${e.message}`);
  }
}

export function fetchSource(name, cfg, secrets, signal) {
  if (name === 'rpc') return rpcSource(cfg, signal);
  if (name === 'feed') return feedSource(cfg, secrets, signal);
  if (name === 'file') return Promise.resolve().then(() => fileSource(cfg));
  if (name === 'sdk') return sdkSource(cfg, signal);
  return Promise.reject(new Error(`unknown source ${name}`));
}

// ---- persistence, staffing, submission -----------------------------------------------------------------------------

const COMP_SELECT = `SELECT c.*, a.name AS agent_name, t.key AS task_key, t.status AS task_status
  FROM bt_competitions c LEFT JOIN agents a ON a.id = c.agent_id LEFT JOIN tasks t ON t.id = c.task_id`;

export function getCompetition(id) {
  return one(`${COMP_SELECT} WHERE c.id = $1`, [id]);
}

export function listCompetitions({ all = false, limit = 100 } = {}) {
  return many(`${COMP_SELECT} ${all ? '' : `WHERE c.status <> 'baseline'`} ORDER BY c.detected_at DESC, c.id LIMIT $1`, [limit]);
}

async function publishCompetition(id) {
  const c = await getCompetition(id);
  if (c) emit('bittensor:competition', c);
  return c;
}

const inFilter = (cfg, netuid) => (netuid === null || !cfg.subnets.include.length || cfg.subnets.include.includes(netuid)) && !(netuid !== null && cfg.subnets.exclude.includes(netuid));

const describe = (c) => (c.netuid !== null && c.netuid !== undefined ? `subnet ${c.netuid}${c.name && c.name !== `Subnet ${c.netuid}` ? ` (${c.name})` : ''}` : c.name);

function taskDescription(c, cfg, blockers) {
  const lines = [
    `A new Bittensor competition started on ${cfg.network}: ${describe(c)}.`,
    c.registered_block ? `Registered at block ${c.registered_block}.` : null,
    c.detail?.description || null,
    c.detail?.url ? `More: ${c.detail.url}` : null,
    '',
    'Goal: prepare and run a competitive miner for this subnet.',
    '- Read the subnet repository and its incentive mechanism; note the hardware and stake requirements.',
    '- Register the hotkey on the subnet (the submission step does this when auto-submit is armed) and serve the miner.',
    '- Report the registration status, UID and first incentive/emission readings.',
    '',
    blockers.length ? `Submission: dry run (${blockers.join(', ')}).` : 'Submission: auto-submit is armed; the configured submit command runs once for this competition.',
    `Competition ref: ${c.id}`,
  ];
  return lines.filter((l) => l !== null).join('\n');
}

/** Values that must never appear in logs, the DB or the UI. */
const secretValues = (secrets) => [secrets.wallet.coldkeyMnemonic, secrets.wallet.coldkeyPassword, ...Object.values(secrets.apiKeys || {})].filter((v) => v && v.length >= 4);

export function redact(text, secrets) {
  let out = String(text || '');
  for (const v of secretValues(secrets)) out = out.split(v).join('***');
  return out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n… (truncated)` : out;
}

export function createWatcher({ configPath = CONFIG_PATH, secretsPath = SECRETS_PATH, log = console, sources = null } = {}) {
  let timer = null, running = null, halted = false, started = false;
  let controller = new AbortController();
  let lastInert;
  let lastErrorLogged = null;
  const state = { state: 'stopped', reason: null, lastPollAt: null, lastError: null, lastFound: null, settings: null };

  const info = (msg) => log.log(`[bittensor] ${msg}`);
  const warn = (msg) => log.warn(`[bittensor] ${msg}`);
  const fetchFrom = sources ? (name, cfg, secrets, signal) => sources(name, cfg, secrets, signal) : fetchSource;

  function status() {
    const s = state.settings;
    const cfg = s?.config;
    return {
      state: state.state, reason: state.reason, lastPollAt: state.lastPollAt, lastError: state.lastError, lastFound: state.lastFound,
      enabled: !!cfg?.enabled && !s?.inert, network: cfg?.network || null, endpoint: cfg?.endpoint || null, sources: cfg?.sources || [],
      pollIntervalSec: cfg?.pollIntervalSec || null, autoSubmit: !!cfg?.autoSubmit, dryRun: cfg ? cfg.dryRun : true,
      keysPresent: keysPresent(s?.secrets), submitArmed: !!cfg && !s?.inert && !submitBlockers(cfg, s.secrets).length,
      configFile: path.relative(ROOT, configPath), secretsFile: path.relative(ROOT, secretsPath),
    };
  }
  const pushStatus = () => emit('bittensor:status', status());

  async function ingest(source, cfg, items) {
    const network = cfg.network;
    const baselined = await one(`SELECT 1 FROM bt_watch_state WHERE network = $1 AND source = $2`, [network, source]);
    if (!baselined) {
      if (cfg.baselineOnFirstRun) {
        for (const it of items) {
          await query(`INSERT INTO bt_competitions(network, source, external_id, netuid, name, registered_block, detail, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'baseline') ON CONFLICT (network, external_id) DO NOTHING`,
          [network, source, it.external_id, it.netuid, it.name, it.registered_block, it.detail]);
        }
        await query(`INSERT INTO bt_watch_state(network, source) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [network, source]);
        info(`first poll of ${source} on ${network}: recorded ${items.length} existing competition(s) as baseline; only later ones trigger agents`);
        return 0;
      }
      await query(`INSERT INTO bt_watch_state(network, source) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [network, source]);
    }
    let fresh = 0;
    for (const it of items) {
      const status = inFilter(cfg, it.netuid) ? 'detected' : 'ignored';
      const row = await one(`INSERT INTO bt_competitions(network, source, external_id, netuid, name, registered_block, detail, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (network, external_id) DO NOTHING RETURNING id`,
      [network, source, it.external_id, it.netuid, it.name, it.registered_block, it.detail, status]);
      if (!row) continue;
      fresh++;
      info(`new competition on ${network}: ${describe(it)}${status === 'ignored' ? ' — outside the subnet filter, ignored' : ''}`);
      await publishCompetition(row.id);
    }
    return fresh;
  }

  /** Create the competition's miner agent and task, exactly once (a crash mid-way resumes from the agent's ref). */
  async function staff(id, cfg, secrets) {
    const c = await one(`UPDATE bt_competitions SET status = 'staffing', updated_at = now() WHERE id = $1 AND status = 'detected' RETURNING *`, [id]);
    if (!c) return;
    const ref = `Competition ref: ${c.id}`;
    let agent = await one(`SELECT id, name FROM agents WHERE role = 'miner' AND position($1 in coalesce(mission, '')) > 0 ORDER BY created_at LIMIT 1`, [ref]);
    if (!agent) {
      agent = await createAgent({
        role: 'miner',
        mission: `Mine Bittensor ${c.network} ${describe(c)}. ${ref}`,
        purpose: 'Compete in new Bittensor subnets as soon as they open.',
      });
    }
    const core = await one(`SELECT id FROM projects WHERE protected = true ORDER BY created_at LIMIT 1`);
    let task = c.task_id ? { id: c.task_id } : await one(`SELECT id FROM tasks WHERE origin = 'bittensor' AND position($1 in coalesce(description, '')) > 0 LIMIT 1`, [ref]);
    if (!task && core) {
      task = await one(
        `INSERT INTO tasks(project_id, key, title, description, role, skills, acceptance, status, origin, agent_id)
         VALUES ($1,$2,$3,$4,'miner',$5,$6,'pending','bittensor',$7) RETURNING id`,
        [core.id, `BT-${c.netuid ?? c.external_id.slice(3, 20)}`, `Mine Bittensor ${describe(c)}`.slice(0, 200), taskDescription(c, cfg, submitBlockers(cfg, secrets)),
          JSON.stringify(['bittensor', 'python']), JSON.stringify(['Miner registered and serving on the subnet', 'Registration outcome reported']), agent.id]);
      const t = await one(`SELECT t.*, a.name AS agent_name, a.role AS agent_role FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.id = $1`, [task.id]);
      if (t) emit('task:update', t);
    }
    await query(`UPDATE bt_competitions SET status = 'staffed', agent_id = $2, task_id = $3, submit_status = coalesce(submit_status, 'pending'), updated_at = now() WHERE id = $1`,
      [c.id, agent.id, task?.id || null]);
    await audit('bittensor', 'competition.staffed', c.id, { network: c.network, netuid: c.netuid, agent: agent.name });
    const blockers = submitBlockers(cfg, secrets);
    await notify({
      source_type: 'system', source_name: 'Bittensor', agent_id: agent.id, level: 'info',
      title: `New Bittensor competition: ${describe(c)}`,
      body: `${c.network}${c.registered_block ? ` · block ${c.registered_block}` : ''} · Mino agent ${agent.name} created · ${blockers.length ? 'submission: dry run' : 'auto-submit armed'}`,
    });
    info(`created Mino agent ${agent.name} for ${describe(c)}`);
    await publishCompetition(c.id);
  }

  async function submit(id, cfg, secrets) {
    const c = await one(`UPDATE bt_competitions SET submit_status = 'running', updated_at = now() WHERE id = $1 AND submit_status = 'pending' RETURNING *`, [id]);
    if (!c) return;
    await publishCompetition(c.id);
    const blockers = submitBlockers(cfg, secrets);
    if (blockers.length) {
      const out = `would submit (dry-run): ${cfg.submit.command.join(' ')} for ${describe(c)} on ${cfg.network} — ${blockers.join(', ')}`;
      info(out);
      await query(`UPDATE bt_competitions SET submit_status = 'dry-run', submit_output = $2, updated_at = now() WHERE id = $1`, [c.id, out]);
      return publishCompetition(c.id);
    }
    const agent = c.agent_id ? await one(`SELECT name FROM agents WHERE id = $1`, [c.agent_id]) : null;
    const w = secrets.wallet;
    const env = {
      BT_NETWORK: cfg.network, BT_ENDPOINT: cfg.endpoint, BT_NETUID: c.netuid === null ? '' : String(c.netuid),
      BT_COMPETITION_ID: c.id, BT_COMPETITION_NAME: c.name || '', BT_AGENT_NAME: agent?.name || '',
      BT_WALLET_NAME: w.name, BT_WALLET_HOTKEY: w.hotkey, BT_WALLET_PATH: w.path, BT_COLDKEY_PATH: w.coldkeyPath,
      BT_COLDKEY_MNEMONIC: w.coldkeyMnemonic, BT_COLDKEY_PASSWORD: w.coldkeyPassword,
    };
    info(`submitting ${describe(c)}: ${cfg.submit.command.join(' ')}`);
    const r = await runCommand(cfg.submit.command, { env, timeoutMs: cfg.submit.timeoutSec * 1000, signal: controller.signal });
    const ok = r.code === 0;
    const why = r.error ? `failed to start: ${r.error}` : r.aborted ? 'aborted by shutdown' : r.timedOut ? `timed out after ${cfg.submit.timeoutSec}s` : `exit code ${r.code}`;
    const output = redact(`${ok ? 'submitted' : `failed (${why})`}\n${r.output}`.trim(), secrets);
    await query(`UPDATE bt_competitions SET submit_status = $2, submit_output = $3, submitted_at = now(), updated_at = now() WHERE id = $1`, [c.id, ok ? 'submitted' : 'failed', output]);
    (ok ? info : warn)(`submission for ${describe(c)} ${ok ? 'succeeded' : `failed (${why})`}`);
    await audit('bittensor', ok ? 'competition.submitted' : 'competition.submit_failed', c.id, { netuid: c.netuid, why: ok ? null : why });
    await notify({
      source_type: 'system', source_name: 'Bittensor', agent_id: c.agent_id, level: ok ? 'success' : 'error',
      title: ok ? `Submitted to Bittensor ${describe(c)}` : `Bittensor submission failed: ${describe(c)}`,
      body: ok ? null : why,
    }).catch(() => {});
    return publishCompetition(c.id);
  }

  /** One poll: reload config, read every source, record new competitions, staff and submit them. Never throws. */
  async function pollOnce() {
    if (running) return running;
    running = (async () => {
      const settings = loadSettings({ configPath, secretsPath });
      state.settings = settings;
      if (settings.secretsError && settings.secretsError !== lastErrorLogged) { warn(`${settings.secretsError} — submission stays off`); lastErrorLogged = settings.secretsError; }
      if (settings.inert) {
        if (settings.inert !== lastInert) info(`watcher inert: ${settings.inert}`);
        lastInert = settings.inert;
        Object.assign(state, { state: 'inert', reason: settings.inert });
        return { inert: settings.inert };
      }
      if (lastInert !== null) info(`watcher active: ${settings.config.network} via ${settings.config.sources.join(', ')}, every ${settings.config.pollIntervalSec}s (autoSubmit ${settings.config.autoSubmit}, dryRun ${settings.config.dryRun})`);
      lastInert = null;
      Object.assign(state, { state: 'polling', reason: null });
      const { config: cfg, secrets } = settings;
      const errors = [];
      let found = 0, fresh = 0;
      for (const name of cfg.sources) {
        if (halted) break;
        try {
          const items = await fetchFrom(name, cfg, secrets, controller.signal);
          found += items.length;
          fresh += await ingest(name, cfg, items);
        } catch (e) {
          errors.push(`${name}: ${e.message}`);
        }
      }
      // Work left over from this poll or from before a restart: staff detected rows, then run pending submissions.
      try {
        for (const r of await many(`SELECT id FROM bt_competitions WHERE status = 'detected' ORDER BY detected_at, id`)) {
          if (halted) break;
          await staff(r.id, cfg, secrets).catch((e) => errors.push(`staffing: ${e.message}`));
        }
        for (const r of await many(`SELECT id FROM bt_competitions WHERE submit_status = 'pending' ORDER BY detected_at, id`)) {
          if (halted) break;
          await submit(r.id, cfg, secrets).catch((e) => errors.push(`submission: ${e.message}`));
        }
      } catch (e) {
        errors.push(`db: ${e.message}`);
      }
      const err = errors.length ? redact(errors.join('; '), secrets) : null;
      if (err && err !== lastErrorLogged) warn(`poll failed: ${err}`);
      if (!err && state.lastError) info('poll recovered');
      lastErrorLogged = err;
      Object.assign(state, { state: halted ? 'stopped' : err ? 'error' : 'idle', lastPollAt: new Date().toISOString(), lastError: err, lastFound: found });
      return { found, fresh, error: err };
    })().catch((e) => {
      // Last line of defence: nothing escapes into the server.
      warn(`poll crashed: ${e.message}`);
      Object.assign(state, { state: 'error', lastError: e.message });
      return { error: e.message };
    }).finally(() => { running = null; pushStatus(); });
    return running;
  }

  function schedule(sec) {
    clearTimeout(timer);
    if (halted) return;
    timer = setTimeout(async () => {
      timer = null;
      const r = await pollOnce();
      schedule(r.inert ? INERT_RECHECK_SEC : state.settings?.config?.pollIntervalSec || DEFAULTS.pollIntervalSec);
    }, sec * 1000);
    timer.unref();
  }

  /** Begin watching (non-blocking). Recovers rows a crash left half-done: staffing resumes, a submission is never re-run. */
  async function start({ delaySec = 1 } = {}) {
    if (started) return;
    started = true;
    halted = false;
    lastInert = undefined;
    try {
      await query(`UPDATE bt_competitions SET status = 'detected', updated_at = now() WHERE status = 'staffing'`);
      await query(`UPDATE bt_competitions SET submit_status = 'failed', submit_output = coalesce(submit_output || E'\\n', '') || 'interrupted by a restart; not re-run automatically', updated_at = now() WHERE submit_status = 'running'`);
    } catch (e) {
      warn(`recovery skipped: ${e.message}`);
    }
    Object.assign(state, { state: 'idle' });
    schedule(delaySec);
  }

  /** Stop polling, abort any request or command in flight and wait (bounded) for the current poll to finish. */
  async function stop({ waitMs = 5000 } = {}) {
    halted = true;
    started = false;
    clearTimeout(timer);
    timer = null;
    controller.abort();
    if (running) await Promise.race([running, new Promise((r) => setTimeout(r, waitMs).unref())]);
    controller = new AbortController();
    state.state = 'stopped';
  }

  return { start, stop, pollOnce, status, get timer() { return timer; } };
}
