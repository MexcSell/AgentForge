import {
  Crown, Dna, Workflow, Network, AppWindow, Server, Code2, PenTool, Database, Brain, Rocket, Telescope, BookOpen, Bug, ShieldCheck,
  BadgeCheck, Gauge, WandSparkles, Bot, Folder, FolderOpen, FileCode, FileJson, FileText, FileImage, FileVideo, FileAudio, FileArchive,
  FileSpreadsheet, FileLock, FileCog, FileType, File, Terminal, GitBranch, Container, Package, Lock,
} from 'lucide-react';

export const ROLE_STYLE = {
  executive: { icon: Crown, from: '#f59e0b', to: '#ea580c' },
  evolution: { icon: Dna, from: '#d946ef', to: '#8b5cf6' },
  manager: { icon: Workflow, from: '#6366f1', to: '#4338ca' },
  architect: { icon: Network, from: '#0ea5e9', to: '#2563eb' },
  frontend: { icon: AppWindow, from: '#8b5cf6', to: '#6366f1' },
  backend: { icon: Server, from: '#10b981', to: '#047857' },
  fullstack: { icon: Code2, from: '#14b8a6', to: '#0e7490' },
  designer: { icon: PenTool, from: '#ec4899', to: '#be185d' },
  data: { icon: Database, from: '#06b6d4', to: '#0369a1' },
  ai: { icon: Brain, from: '#a855f7', to: '#6d28d9' },
  devops: { icon: Rocket, from: '#f97316', to: '#c2410c' },
  research: { icon: Telescope, from: '#84cc16', to: '#15803d' },
  docs: { icon: BookOpen, from: '#64748b', to: '#334155' },
  qa: { icon: Bug, from: '#ef4444', to: '#b91c1c' },
  security: { icon: ShieldCheck, from: '#f43f5e', to: '#9f1239' },
  reviewer: { icon: BadgeCheck, from: '#eab308', to: '#a16207' },
  analyst: { icon: Gauge, from: '#3b82f6', to: '#1e40af' },
  optimizer: { icon: WandSparkles, from: '#e879f9', to: '#a21caf' },
};
const FALLBACK = { icon: Bot, from: '#71717a', to: '#3f3f46' };

export const roleStyle = (role) => ROLE_STYLE[role] || FALLBACK;

export function RoleIcon({ role, size = 16, className = '' }) {
  const I = roleStyle(role).icon;
  return <I size={size} className={className} strokeWidth={2} />;
}

const FILE_TYPES = [
  [/^(js|mjs|cjs)$/, FileCode, '#eab308'],
  [/^(jsx|tsx)$/, FileCode, '#22d3ee'],
  [/^(ts|mts|cts)$/, FileCode, '#3b82f6'],
  [/^json$/, FileJson, '#f59e0b'],
  [/^(md|mdx|markdown)$/, FileText, '#38bdf8'],
  [/^(css|scss|sass|less)$/, FileCode, '#ec4899'],
  [/^(html|htm|vue|svelte|astro)$/, FileCode, '#f97316'],
  [/^py$/, FileCode, '#60a5fa'],
  [/^(go|rs|java|kt|swift|rb|php|c|cc|cpp|h|hpp|cs|scala|dart|lua|zig)$/, FileCode, '#a78bfa'],
  [/^(sh|bash|zsh|fish|ps1|bat)$/, Terminal, '#22c55e'],
  [/^(yml|yaml|toml|ini|conf|cfg|env|properties|xml)$/, FileCog, '#c084fc'],
  [/^(png|jpe?g|gif|webp|svg|ico|bmp|avif|tiff?)$/, FileImage, '#10b981'],
  [/^(mp4|webm|mov|mkv|avi)$/, FileVideo, '#f43f5e'],
  [/^(mp3|wav|ogg|flac|m4a)$/, FileAudio, '#d946ef'],
  [/^(zip|tar|gz|tgz|bz2|xz|7z|rar)$/, FileArchive, '#b45309'],
  [/^pdf$/, FileText, '#ef4444'],
  [/^(csv|tsv|xlsx?|ods)$/, FileSpreadsheet, '#16a34a'],
  [/^(pptx?|docx?|odt|key)$/, FileType, '#fb923c'],
  [/^(lock)$/, FileLock, '#71717a'],
  [/^(sql|db|sqlite)$/, Database, '#06b6d4'],
  [/^(txt|log|out)$/, FileText, '#a1a1aa'],
  [/^(pem|key|crt)$/, Lock, '#f59e0b'],
];

export function fileVisual(entry, open = false) {
  if (entry.type === 'dir') return { icon: open ? FolderOpen : Folder, color: entry.name === '.git' ? '#f97316' : entry.name === 'node_modules' ? '#71717a' : '#f5b041' };
  const n = entry.name.toLowerCase();
  if (n === 'dockerfile' || n.startsWith('docker-compose')) return { icon: Container, color: '#3b82f6' };
  if (n === 'package.json') return { icon: Package, color: '#ef4444' };
  if (n.startsWith('.git')) return { icon: GitBranch, color: '#f97316' };
  if (n.startsWith('.env')) return { icon: FileCog, color: '#eab308' };
  for (const [re, icon, color] of FILE_TYPES) if (re.test(entry.ext || '')) return { icon, color };
  return { icon: File, color: '#a1a1aa' };
}

export function FileIcon({ entry, open, size = 16 }) {
  const { icon: I, color } = fileVisual(entry, open);
  return <I size={size} color={color} strokeWidth={1.9} className="shrink-0" />;
}

export function GithubMark({ size = 16, className = '' }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export const PROVIDER_STYLE = {
  'claude-code': { from: '#d97757', to: '#b4552d', label: 'Claude Code' },
  codex: { from: '#3b82f6', to: '#1d4ed8', label: 'Codex CLI' },
  anthropic: { from: '#c96442', to: '#8f3f22', label: 'Anthropic API' },
  gpt: { from: '#a855f7', to: '#a21caf', label: 'OpenAI GPT' },
  openai: { from: '#10a37f', to: '#0b6e56', label: 'OpenAI-compatible' },
  simulator: { from: '#71717a', to: '#3f3f46', label: 'Simulator' },
};
