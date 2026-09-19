import { useCallback, useEffect, useRef } from 'react';
import type { Adjustments } from '../../types';
import { defaultAdjustments } from '../../types';
import { getDefaultPipelineService, buildAdjustmentsGraph } from '../../engine/graph';
import type { PlanHandle } from '../../engine/graph';
import { benchSourceSpec } from './benchSourceSpec';
import type { LensCoefficients } from '../../engine/lensProfile';
import type { BenchSource } from './useBenchSources';

/** A bound source plus the canvas its render belongs in. */
export interface BenchRenderTarget {
  source: BenchSource;
  boundId: string;
  canvas: HTMLCanvasElement;
}

/**
 * Render every bound bench source through one set of adjustments.
 *
 * Two things keep this affordable enough to sit under a slider:
 *
 * Sources stay bound in the worker, so a pass is N GL renders and no decodes.
 * And the compiled plan is reused — `graphId` is derived from geometry and
 * colour space, never from slider values, so moving a slider changes the
 * params handed to `renderToImageBitmap` and nothing about the plan.
 *
 * Passes never overlap. While one is running the newest adjustments are only
 * remembered; when it finishes, exactly one further pass runs with whatever
 * the sliders say by then. A pass whose generation has been overtaken drops
 * its bitmaps instead of painting them, so a fast drag cannot leave a tile
 * showing an older value than its neighbours.
 */
export function useBenchRender(
  sources: BenchSource[],
  adjustments: Adjustments,
  getCanvas: (photoId: number) => HTMLCanvasElement | null,
  onPassMs?: (ms: number) => void,
  /**
   * Lens coefficients to render with instead of the photo's own.
   *
   * Applied here rather than when the source is bound: the lens bench moves
   * these on every slider drag, and a bound source is decoded once and never
   * looked at again.
   */
  lensProfileOverride?: LensCoefficients | null,
) {
  const plansRef = useRef(new Map<string, PlanHandle>());
  const generationRef = useRef(0);
  const runningRef = useRef(false);
  const latestRef = useRef<{
    sources: BenchSource[];
    adjustments: Adjustments;
    lensProfileOverride?: LensCoefficients | null;
  } | null>(null);

  const runPass = useCallback(async () => {
    if (runningRef.current) return;
    const job = latestRef.current;
    if (!job) return;
    latestRef.current = null;
    runningRef.current = true;

    const generation = ++generationRef.current;
    const svc = getDefaultPipelineService();
    const started = performance.now();

    try {
      const targets: BenchRenderTarget[] = [];
      for (const s of job.sources) {
        if (s.status !== 'ready' || !s.boundId) continue;
        const canvas = getCanvas(s.photoId);
        if (canvas) targets.push({ source: s, boundId: s.boundId, canvas });
      }

      for (const target of targets) {
        if (generation !== generationRef.current) return;
        const values = target.source.reference ? defaultAdjustments : job.adjustments;
        const shape = job.lensProfileOverride !== undefined
          ? { ...target.source, lensProfile: job.lensProfileOverride }
          : target.source;
        const spec = buildAdjustmentsGraph(values, benchSourceSpec(shape));

        let plan = plansRef.current.get(spec.graph.id);
        if (!plan) {
          plan = await svc.compile(spec.graph);
          plansRef.current.set(spec.graph.id, plan);
        }

        const { bitmap, width, height } = await svc.renderToImageBitmap(plan, target.boundId, spec.params);
        if (generation !== generationRef.current) { bitmap.close(); return; }

        const ctx = target.canvas.getContext('2d');
        if (!ctx) { bitmap.close(); continue; }
        if (target.canvas.width !== width || target.canvas.height !== height) {
          target.canvas.width = width;
          target.canvas.height = height;
        }
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
      }

      if (targets.length > 0) onPassMs?.(performance.now() - started);
    } catch (e) {
      console.warn('[Bench] render pass failed', e);
    } finally {
      runningRef.current = false;
      // Something arrived while this pass was busy - run once more, with the
      // newest values rather than every value the slider passed through.
      if (latestRef.current) void runPass();
    }
  }, [getCanvas, onPassMs]);

  useEffect(() => {
    latestRef.current = { sources, adjustments, lensProfileOverride };
    void runPass();
  }, [sources, adjustments, lensProfileOverride, runPass]);

  useEffect(() => {
    const plans = plansRef.current;
    return () => {
      const svc = getDefaultPipelineService();
      for (const plan of plans.values()) void svc.releasePlan(plan);
      plans.clear();
    };
  }, []);
}
