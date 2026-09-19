/* eslint-disable react-refresh/only-export-components -- Provider and companion hook intentionally share one context module. */
import { createContext, useContext } from 'react';
import type { EditorTool } from '../ui/ToolStrip';
import type { RawPixelData } from '../engine/raw/RawDecoderStrategy';

export interface EditorContextValue {
  zoom: number;
  panX: number;
  panY: number;
  setZoom: (z: number) => void;
  setPanX: (x: number) => void;
  setPanY: (y: number) => void;
  fitScale: number;
  containerDims: { w: number; h: number };
  nativeImgDims: { w: number; h: number };
  imgDims: { w: number; h: number };
  displayImgW: number;
  displayImgH: number;
  renderGen: number;
  glCanvasEl: HTMLCanvasElement | null;
  /** Canvas with pre-tonecurve render (for ToneCurve/Levels histograms) */
  preCurveCanvas: HTMLCanvasElement | null;
  /** Generation of the pre-curve pixels (separate from the full render). */
  preCurveGen: number;
  displayUrl: string | null;
  isRaw: boolean;
  /**
   * The camera JPEG of the open RAW, when the editor shows the RAW half of a
   * RAW+JPEG pair and the browser can decode the sibling. It is the reference
   * the Auto button can optimize *towards* instead of towards a generic ideal.
   * `resolveUrl` is lazy — nothing is fetched until the user asks for it.
   */
  matchReference: { name: string; resolveUrl: () => Promise<string | null> } | null;
  /** 16-bit linear pixels when source is RAW + smart-preview cache hit.
   *  Downstream consumers (preset thumbs) feed this into the raw16 graph
   *  so HDR-linear math matches the editor exactly. */
  rawPixels: RawPixelData | null;
  /**
   * The open photo's camera base development, or null. Preset thumbnails need
   * it: a preset preview rendered without the base promises a look the photo
   * cannot reach, because the preset lands on top of the base and not
   * instead of it.
   */
  rawBaseAdjustments: import('../engine/graph').BuilderAdjustments | null;
  /** The open photo's lens correction, or null. Preset thumbnails need it too. */
  rawLensProfile: import('../engine/lensProfile').LensCoefficients | null;
  activeTool: EditorTool;
  onToolChange: (tool: EditorTool) => void;
  handleOneToOne: () => void;
  onPanChange: (x: number, y: number) => void;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditor(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) {
    console.warn('useEditor: no provider found (HMR?). Using fallback.');
    return {
      zoom: 1, panX: 0, panY: 0,
      setZoom: () => {}, setPanX: () => {}, setPanY: () => {},
      fitScale: 1,
      containerDims: { w: 0, h: 0 },
      nativeImgDims: { w: 0, h: 0 },
      imgDims: { w: 0, h: 0 },
      displayImgW: 0, displayImgH: 0,
      renderGen: 0,
      glCanvasEl: null, preCurveCanvas: null, preCurveGen: 0,
      displayUrl: null,
      isRaw: false,
      matchReference: null,
      rawPixels: null,
      rawBaseAdjustments: null,
      rawLensProfile: null,
      activeTool: 'edit',
      onToolChange: () => {},
      handleOneToOne: () => {},
      onPanChange: () => {},
    };
  }
  return ctx;
}

interface EditorProviderProps {
  value: EditorContextValue;
  children: React.ReactNode;
}

export function EditorProvider({ value, children }: EditorProviderProps) {
  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}
