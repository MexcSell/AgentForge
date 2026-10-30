// Linux host metrics for the status bar. Reads only small /proc and /sys files and never
// spawns a process. Rates are deltas against the previous sample, so the first sample of a
// sampler only primes the counters. Every field that cannot be read is reported as null.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const read = (file) => fsp.readFile(file, 'utf8').catch(() => null);
const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const round = (n, d = 1) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const clampPct = (n) => (n == null || !Number.isFinite(n) ? null : round(Math.min(100, Math.max(0, n))));
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
// Counter delta; null when a side is missing or the counter went backwards (reset / wrap).
const delta = (a, b) => (a == null || b == null || a < b ? null : a - b);
// mountinfo escapes space, tab, newline and backslash as octal.
const unescapeMount = (s) => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));

export function createSampler({ root = config.root, proc = '/proc', sys = '/sys' } = {}) {
  let prev = null;
  let statics = null;

  // Things that do not change while the sampler runs: CPU directories, max frequency, the disk under root.
  async function loadStatics() {
    const cpuBase = path.join(sys, 'devices/system/cpu');
    const cpuDirs = (await fsp.readdir(cpuBase).catch(() => [])).filter((n) => /^cpu\d+$/.test(n)).map((n) => path.join(cpuBase, n));
    const maxKhz = (await Promise.all(cpuDirs.map((d) => read(path.join(d, 'cpufreq/cpuinfo_max_freq'))))).map(num).filter((n) => n > 0);
    return { cpuDirs, maxGhz: maxKhz.length ? round(Math.max(...maxKhz) / 1e6, 2) : null, disk: await rootDevice() };
  }

  // The filesystem holding `root`: the longest matching mount point in mountinfo (later overmounts win).
  async function rootDevice() {
    const text = await read(path.join(proc, 'self/mountinfo'));
    if (!text) return null;
    const real = await fsp.realpath(root).catch(() => root);
    let best = null;
    for (const line of text.split('\n')) {
      const [left, right] = line.split(' - ');
      if (!right) continue;
      const f = left.split(' ');
      const mount = unescapeMount(f[4] || '');
      if (!mount || !(mount === '/' || real === mount || real.startsWith(mount + '/'))) continue;
      if (best && mount.length < best.mount.length) continue;
      const [major, minor] = (f[2] || '').split(':');
      const source = right.split(' ')[1] || '';
      best = { mount, major, minor, name: source.startsWith('/dev/') ? path.basename(source) : null };
    }
    return best;
  }

  async function cpuTimes() {
    const text = await read(path.join(proc, 'stat'));
    const lines = text ? text.split('\n') : [];
    const agg = lines.find((l) => l.startsWith('cpu '));
    if (agg) {
      const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = agg.trim().split(/\s+/).slice(1).map(Number);
      if ([user, nice, system, idle].every(Number.isFinite)) {
        return { src: 'stat', busy: user + nice + system + irq + softirq + steal, idle: idle + iowait, cores: lines.filter((l) => /^cpu\d+\s/.test(l)).length || null };
      }
    }
    const cpus = os.cpus();
    if (!cpus.length) return null;
    let busy = 0;
    let idle = 0;
    for (const { times: t } of cpus) { busy += t.user + t.nice + t.sys + t.irq; idle += t.idle; }
    return { src: 'os', busy, idle, cores: cpus.length };
  }

  async function cpuGhz() {
    const khz = (await Promise.all(statics.cpuDirs.map((d) => read(path.join(d, 'cpufreq/scaling_cur_freq'))))).map(num).filter((n) => n > 0);
    if (khz.length) return avg(khz) / 1e6;
    const info = await read(path.join(proc, 'cpuinfo'));
    const mhz = info ? [...info.matchAll(/^cpu MHz\s*:\s*([\d.]+)/gm)].map((m) => Number(m[1])).filter((n) => n > 0) : [];
    if (mhz.length) return avg(mhz) / 1e3;
    const speeds = os.cpus().map((c) => c.speed).filter((n) => n > 0);
    return speeds.length ? avg(speeds) / 1e3 : null;
  }

  async function memory() {
    const text = await read(path.join(proc, 'meminfo'));
    const kb = (key) => num(text?.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1]);
    const total = kb('MemTotal');
    const available = kb('MemAvailable');
    const used = total && available != null ? total - available : null;
    if (used == null) return { usedGb: null, totalGb: total ? round((total * 1024) / GB, 2) : null, percent: null };
    return { usedGb: round((used * 1024) / GB, 2), totalGb: round((total * 1024) / GB, 2), percent: clampPct((used / total) * 100) };
  }

  // df-style: used = blocks − bfree, percent = used / (used + bavail).
  async function capacity() {
    const s = await fsp.statfs(root).catch(() => null);
    if (!s) return { usedGb: null, totalGb: null, percent: null };
    const used = (s.blocks - s.bfree) * s.bsize;
    const avail = s.bavail * s.bsize;
    return { usedGb: round(used / GB, 2), totalGb: round((s.blocks * s.bsize) / GB, 2), percent: used + avail > 0 ? clampPct((used / (used + avail)) * 100) : null };
  }

  // /proc/diskstats row of the root device, by major:minor first, then by the mount source name.
  async function diskCounters() {
    const dev = statics.disk;
    const text = dev && (await read(path.join(proc, 'diskstats')));
    if (!text) return null;
    let row = null;
    for (const line of text.split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f.length < 13) continue;
      if (f[0] === dev.major && f[1] === dev.minor) { row = f; break; }
      if (!row && dev.name && f[2] === dev.name) row = f;
    }
    return row && { read: Number(row[5]), written: Number(row[9]), ioTicks: Number(row[12]) };
  }

  // Byte counters of the default-route interface, else the sum of every non-loopback interface.
  async function netCounters() {
    const [route, dev] = await Promise.all([read(path.join(proc, 'net/route')), read(path.join(proc, 'net/dev'))]);
    if (!dev) return null;
    let iface = null;
    let metric = Infinity;
    for (const line of (route || '').split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[1] === '00000000' && Number(f[6]) < metric) { iface = f[0]; metric = Number(f[6]); }
    }
    const rows = {};
    for (const line of dev.split('\n').slice(2)) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const f = line.slice(i + 1).trim().split(/\s+/).map(Number);
      rows[line.slice(0, i).trim()] = { rx: f[0], tx: f[8] };
    }
    if (iface && rows[iface]) return { iface, ...rows[iface] };
    let rx = 0;
    let tx = 0;
    for (const [name, r] of Object.entries(rows)) if (name !== 'lo') { rx += r.rx; tx += r.tx; }
    return { iface: null, rx, tx };
  }

  // Negotiated link speed in Mb/s; -1 / 0 (link down, virtual NIC) or unreadable → null.
  async function linkMbps(iface) {
    const speed = iface ? num((await read(path.join(sys, 'class/net', iface, 'speed')))?.trim()) : null;
    return speed > 0 ? speed : null;
  }

  async function counters() {
    const [cpu, disk, net] = await Promise.all([cpuTimes(), diskCounters(), netCounters()]);
    return { t: performance.now(), cpu, disk, net };
  }

  return {
    // Returns a snapshot, or null when this call only primed the counters.
    async sample(intervalSec) {
      statics ??= await loadStatics();
      const last = prev;
      const cur = await counters();
      prev = cur;
      if (!last) return null;

      const ms = cur.t - last.t;
      const sec = ms / 1000;
      const [ghz, mem, cap, link] = await Promise.all([cpuGhz(), memory(), capacity(), linkMbps(cur.net?.iface)]);

      const c = cur.cpu && last.cpu && cur.cpu.src === last.cpu.src ? cur.cpu : null;
      const dBusy = c && delta(c.busy, last.cpu.busy);
      const dIdle = c && delta(c.idle, last.cpu.idle);
      const cpuPercent = dBusy != null && dIdle != null && dBusy + dIdle > 0 ? clampPct((dBusy / (dBusy + dIdle)) * 100) : null;

      const d = cur.disk && last.disk ? cur.disk : null;
      const dTicks = d && delta(d.ioTicks, last.disk.ioTicks);
      const dRead = d && delta(d.read, last.disk.read);
      const dWritten = d && delta(d.written, last.disk.written);

      const n = cur.net && last.net && cur.net.iface === last.net.iface ? cur.net : null;
      const dRx = n && delta(n.rx, last.net.rx);
      const dTx = n && delta(n.tx, last.net.tx);
      const rxMbps = dRx == null || !sec ? null : (dRx * 8) / sec / 1e6;
      const txMbps = dTx == null || !sec ? null : (dTx * 8) / sec / 1e6;

      return {
        ts: Date.now(),
        intervalSec,
        cpu: { percent: cpuPercent, ghz: round(ghz, 2), maxGhz: statics.maxGhz, cores: cur.cpu?.cores ?? os.availableParallelism?.() ?? null },
        memory: mem,
        storage: {
          mount: statics.disk?.mount ?? null,
          ...cap,
          busyPercent: dTicks == null || !ms ? null : clampPct((dTicks / ms) * 100),
          readMBps: dRead == null || !sec ? null : round((dRead * 512) / sec / MB, 2),
          writeMBps: dWritten == null || !sec ? null : round((dWritten * 512) / sec / MB, 2),
        },
        network: {
          iface: cur.net?.iface ?? null,
          rxMbps: round(rxMbps, 2),
          txMbps: round(txMbps, 2),
          linkMbps: link,
          percent: link && rxMbps != null && txMbps != null ? clampPct((Math.max(rxMbps, txMbps) / link) * 100) : null,
        },
      };
    },
    reset() {
      prev = null;
      statics = null;
    },
  };
}

// One-off reading for callers without a running sampler (e.g. the REST endpoint while no
// browser is connected): prime, wait `windowMs`, sample. Concurrent callers share one reading.
let measuring = null;
export function measureOnce(intervalSec, windowMs = 1000) {
  measuring ??= (async () => {
    const s = createSampler();
    await s.sample(intervalSec);
    await new Promise((r) => setTimeout(r, windowMs).unref());
    return s.sample(intervalSec);
  })().finally(() => { measuring = null; });
  return measuring;
}
