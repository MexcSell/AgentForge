import { lazy, Suspense, useEffect, useState } from 'react';
import { useStore, selectUnread, selectWorkingAgents } from './lib/store.js';
import { connectEvents } from './lib/ws.js';
import { updateFavicon } from './lib/favicon.js';
import { getLayout, LAYOUTS } from './lib/layouts.js';
import { ActivityBar, TitleBar, StatusBar, Toasts, CommandPalette, ClientUpdateBanner, VIEWS } from './components/Shell.jsx';
import { ContextMenuHost } from './components/ContextMenu.jsx';
import { Spinner } from './components/ui.jsx';
import { AgentDetailModal } from './views/agents/AgentDetail.jsx';
import Dashboard from './views/Dashboard.jsx';
import Projects from './views/projects/Projects.jsx';

const Agents = lazy(() => import('./views/agents/Agents.jsx'));
const Files = lazy(() => import('./views/files/Files.jsx'));
const Models = lazy(() => import('./views/Models.jsx'));
const GitHub = lazy(() => import('./views/GitHub.jsx'));
const Settings = lazy(() => import('./views/Settings.jsx'));

const VIEW_COMPONENTS = { dashboard: Dashboard, projects: Projects, agents: Agents, files: Files, models: Models, github: GitHub, settings: Settings };

function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 760);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < 760);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return narrow;
}

export default function App() {
  const st = useStore();
  const unread = useStore(selectUnread);
  const working = useStore((s) => selectWorkingAgents(s).length);
  const narrow = useNarrow();
  const layout = narrow ? { ...LAYOUTS.find((l) => l.id === 'mobile'), name: getLayout(st.layoutId).name } : getLayout(st.layoutId);

  useEffect(() => { connectEvents(); }, []);

  // Theme, accent and screen format → CSS variables on <html>.
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const t = st.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : st.theme;
      root.dataset.theme = t;
    };
    apply();
    root.dataset.accent = st.accent;
    root.dataset.density = layout.density;
    root.style.setProperty('--af-scale', layout.scale);
    root.style.setProperty('--af-radius', `${layout.radius}px`);
    const mq = matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [st.theme, st.accent, layout.density, layout.scale, layout.radius]);

  useEffect(() => {
    const status = !st.connected ? 'offline' : st.system?.status || 'online';
    updateFavicon(status, unread, working);
  }, [st.connected, st.system?.status, unread, working]);

  useEffect(() => {
    const onKey = (e) => {
      // Capture phase: shortcuts work even while the terminal or an editor has focus.
      const digit = /^Digit([1-7])$/.exec(e.code)?.[1];
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); st.set({ palette: !useStore.getState().palette }); }
      else if (e.altKey && !e.ctrlKey && !e.metaKey && digit) {
        e.preventDefault();
        e.stopPropagation();
        st.set({ view: [...VIEWS.map((v) => v.id), 'settings'][Number(digit) - 1] });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const View = VIEW_COMPONENTS[st.view] || Dashboard;
  const bottom = layout.activity === 'bottom';
  return (
    <div className="h-full flex flex-col bg-bg text-fg">
      <TitleBar layout={layout} />
      <div className="flex-1 min-h-0 flex">
        {!bottom && <ActivityBar layout={layout} />}
        <main className={`flex-1 min-w-0 min-h-0 ${layout.floating ? 'bg-bg dotgrid' : 'bg-bg'}`}>
          <div className="h-full mx-auto" style={{ maxWidth: layout.maxWidth || undefined }}>
            {!st.loaded ? (
              <div className="h-full flex items-center justify-center gap-2 text-sm text-muted"><Spinner /> Connecting to AgentForge…</div>
            ) : (
              <Suspense fallback={<div className="h-full flex items-center justify-center"><Spinner /></div>}>
                <View layout={layout} />
              </Suspense>
            )}
          </div>
        </main>
      </div>
      {bottom && <ActivityBar layout={layout} />}
      {layout.statusBar && <StatusBar />}
      <CommandPalette />
      <Toasts />
      <ContextMenuHost />
      <ClientUpdateBanner />
      <AgentDetailModal />
    </div>
  );
}
