import { AppWindow, Bot, Columns3, Laptop, Layers, LayoutGrid, LayoutList, ListTree, Maximize2, MessageSquare, Minimize2, Monitor, PanelsTopLeft, Rows2, Smartphone, Sparkles, Tablet, Target, Terminal, Tv, Type } from 'lucide-react';

// Screen formats. Each preset reshapes the whole shell: scale, density, chrome,
// activity-bar placement and the panel arrangement of every view.
const base = {
  scale: 1,
  density: 'cozy',
  radius: 10,
  activity: 'left', // left | right | bottom
  activityLabels: false,
  statusBar: true,
  maxWidth: null,
  floating: false,
  project: { orientation: 'horizontal', order: ['list', 'chat', 'agents'], sizes: { list: 20, chat: 55, agents: 25 }, hide: [] },
  files: { terminal: 30 },
  dashboard: { orientation: 'horizontal' },
};

const p = (id, name, icon, hint, over = {}) => ({
  ...base, ...over, id, name, icon, hint,
  project: { ...base.project, ...(over.project || {}) },
  files: { ...base.files, ...(over.files || {}) },
  dashboard: { ...base.dashboard, ...(over.dashboard || {}) },
});

export const LAYOUTS = [
  p('standard', 'Standard', PanelsTopLeft, 'VS Code style'),
  p('compact', 'Compact', Minimize2, 'More on screen', { scale: 0.93, density: 'compact', radius: 8 }),
  p('comfortable', 'Comfortable', Maximize2, 'Roomy spacing', { scale: 1.05, density: 'comfortable', radius: 12 }),
  p('focus', 'Focus', Target, 'Command window only', { project: { hide: ['list', 'agents'] } }),
  p('zen', 'Zen', Sparkles, 'Centered, no status bar', { statusBar: false, maxWidth: 1240, project: { hide: ['list'], sizes: { chat: 70, agents: 30 } } }),
  p('wide-chat', 'Wide Chat', MessageSquare, 'Conversation first', { project: { sizes: { list: 16, chat: 66, agents: 18 } } }),
  p('agent-ops', 'Agent Ops', Bot, 'Agents panel wide', { project: { sizes: { list: 18, chat: 42, agents: 40 } } }),
  p('mirror', 'Mirror', Columns3, 'Everything flipped', { activity: 'right', project: { order: ['agents', 'chat', 'list'] } }),
  p('command-center', 'Command Center', LayoutGrid, 'Three equal columns', { project: { sizes: { list: 33, chat: 34, agents: 33 } } }),
  p('terminal-heavy', 'Terminal Heavy', Terminal, 'Big shell', { files: { terminal: 55 } }),
  p('stacked', 'Stacked', Rows2, 'Panels top to bottom', { project: { orientation: 'vertical', sizes: { list: 18, chat: 52, agents: 30 } }, dashboard: { orientation: 'vertical' } }),
  p('presentation', 'Presentation', Tv, 'Large, for screens', { scale: 1.2, density: 'comfortable', radius: 14, statusBar: false }),
  p('large-text', 'Large Text', Type, 'Accessibility', { scale: 1.12, density: 'comfortable' }),
  p('dense', 'Dense Data', LayoutList, 'Maximum density', { scale: 0.86, density: 'compact', radius: 6 }),
  p('ultrawide', 'Ultrawide', AppWindow, '21:9 displays', { activityLabels: true, project: { sizes: { list: 14, chat: 58, agents: 28 } } }),
  p('laptop', 'Laptop 13"', Laptop, 'Small screens', { scale: 0.95, project: { sizes: { list: 22, chat: 54, agents: 24 } }, files: { terminal: 26 } }),
  p('tablet', 'Tablet', Tablet, 'Touch friendly', { activity: 'bottom', density: 'comfortable', scale: 1.04, project: { orientation: 'vertical', sizes: { list: 22, chat: 50, agents: 28 } }, dashboard: { orientation: 'vertical' } }),
  p('mobile', 'Mobile', Smartphone, 'Single column', { activity: 'bottom', statusBar: false, density: 'comfortable', project: { orientation: 'vertical', hide: ['list'], sizes: { chat: 64, agents: 36 } }, files: { terminal: 35 }, dashboard: { orientation: 'vertical' } }),
  p('cinema', 'Cinema', Monitor, 'Centered 1440px', { maxWidth: 1440, radius: 14, floating: true }),
  p('floating', 'Floating Cards', Layers, 'Panels as cards', { floating: true, radius: 14 }),
  p('labeled', 'Labeled Rail', ListTree, 'Activity bar with labels', { activityLabels: true }),
];

export const getLayout = (id) => LAYOUTS.find((l) => l.id === id) || LAYOUTS[0];
