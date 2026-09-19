import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModularPanel } from '../../ui/ModularPanel';
import { PANEL_MAP } from '../../ui/panelRegistry';
import { useToneAdjustmentPanels } from '../../ui/useToneAdjustmentPanels';
import { useColorPanels } from '../../ui/useColorPanels';
import { useToolPanels } from '../../ui/useToolPanels';

interface BenchPanelsProps {
  /** Which panels this bench shows, in order. */
  panelIds: string[];
  /** Which of them start expanded; the rest start collapsed. */
  initiallyOpen: string[];
  /** Panels this bench brings itself, shown above the adjustment stack. */
  extraPanels?: { id: string; title: string; content: React.ReactNode }[];
}

/**
 * The editor's own adjustment panels, rendered in a plain stack.
 *
 * They are used unchanged - every one of them reads its values from
 * `AdjustmentsContext`, so putting a different provider above them is all it
 * takes to point them at the bench instead of at an open photo.
 *
 * Collapse state is local on purpose. `usePanelLayout` is the editor's layout
 * in localStorage; a bench that wrote to it would rearrange the editor behind
 * the user's back.
 */
export function BenchPanels({ panelIds, initiallyOpen, extraPanels }: BenchPanelsProps) {
  const { t } = useTranslation();
  const allIds = [...panelIds, ...(extraPanels ?? []).map((p) => p.id)];
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(allIds.filter((id) => !initiallyOpen.includes(id))),
  );

  // Switching what the bench works on swaps the panel set, and a panel that
  // has never been shown has no state to keep. Without this it inherits
  // "not collapsed" by never having been listed - which looked like it opened
  // on purpose and closed on the first click.
  const known = useRef(new Set(allIds));
  const idsKey = allIds.join(',');
  useEffect(() => {
    const fresh = allIds.filter((id) => !known.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) known.current.add(id);
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (const id of fresh) {
        if (initiallyOpen.includes(id)) next.delete(id);
        else next.add(id);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const tone = useToneAdjustmentPanels();
  const color = useColorPanels({});
  const tools = useToolPanels({});

  const toggle = (id: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="bench-panels">
      {panelIds.map((id) => {
        const definition = PANEL_MAP.get(id);
        const content = tone.get(id) ?? color.get(id) ?? tools.get(id);
        if (!definition || !content) return null;
        return (
          <ModularPanel
            key={id}
            definition={definition}
            collapsed={collapsed.has(id)}
            onToggle={() => toggle(id)}
          >
            {content}
          </ModularPanel>
        );
      })}
      {extraPanels?.map((panel) => (
        <ModularPanel
          key={panel.id}
          definition={{
            id: panel.id, title: panel.title, icon: null,
            defaultZone: 'right', defaultOpen: true, context: 'editor',
          }}
          collapsed={collapsed.has(panel.id)}
          onToggle={() => toggle(panel.id)}
        >
          {panel.content}
        </ModularPanel>
      ))}
      {panelIds.length === 0 && extraPanels === undefined
        && <div className="bench-empty">{t('app.selectFromLibrary')}</div>}
    </div>
  );
}
