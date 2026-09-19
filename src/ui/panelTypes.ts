import type { ReactNode } from 'react';

export type PanelZone = 'left' | 'right' | 'bottom' | 'floating';

export interface PanelDefinition {
  id: string;
  title: string;
  icon: ReactNode;
  defaultZone: PanelZone;
  defaultOpen: boolean;
  context: 'editor' | 'library' | 'both';
}

export interface FloatingPanelPos {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * The docked zone the panel was floated out of. Docking it again puts it
   * back there, and the tablet drawer lists it with that zone's panels — a
   * floating panel has no place of its own on a screen without free space.
   */
  origin?: 'left' | 'right' | 'bottom';
}

export interface PanelLayout {
  left: string[];
  right: string[];
  bottom: string[];
  floating: FloatingPanelPos[];
  collapsed: string[];
  pinned: string[];   // panels pinned to top of their zone (don't scroll)
  leftWidth: number;
  rightWidth: number;
  bottomHeight: number;
}
