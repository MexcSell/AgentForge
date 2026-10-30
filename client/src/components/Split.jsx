import { Fragment } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { cx } from './ui.jsx';

const storage = {
  getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  setItem: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

/**
 * Resizable split container. Every area can be resized; sizes persist per layout.
 * panels: [{ id, size (percent), min (percent), node }]
 */
export function Split({ id, orientation = 'horizontal', panels, floating, className }) {
  const visible = panels.filter(Boolean);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ groupId: `af.split.${id}.${visible.map((p) => p.id).join('-')}`, storage });
  return (
    <Group id={id} orientation={orientation} defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}
      className={cx('h-full w-full', floating && 'gap-0 p-1.5', className)}>
      {visible.map((p, i) => (
        <Fragment key={p.id}>
          {i > 0 && <Separator className={cx('af-sep', floating && '!bg-transparent mx-[3px] my-[3px]')} />}
          <Panel id={p.id} defaultSize={`${p.size}%`} minSize={`${p.min ?? 8}%`} collapsible={p.collapsible}
            className={cx('min-w-0 min-h-0', floating ? 'rounded-[var(--af-radius)] border border-line bg-panel shadow-af overflow-hidden' : 'bg-panel')}>
            {p.node}
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
}
