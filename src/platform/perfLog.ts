/**
 * Performance Logger — global, toggleable, with wall-clock tracking.
 *
 * Usage:
 *   perfLog.start('photo-load');           // Start a named timer
 *   perfLog.mark('photo-load', 'getFile'); // Log a checkpoint
 *   perfLog.end('photo-load');             // End + print summary
 *
 * Enable/disable:
 *   perfLog.enabled = true;
 *   localStorage.setItem(STORAGE_KEYS.perfLog, '1');  // persists across reloads
 *
 * Console shortcut:
 *   window.__perfLog.enabled = true;
 */

import { STORAGE_KEYS } from './storageKeys';

class PerfLog {
  enabled: boolean;
  private timers = new Map<string, { t0: number; marks: { label: string; time: number }[] }>();

  constructor() {
    try {
      this.enabled = localStorage.getItem(STORAGE_KEYS.perfLog) === '1';
    } catch {
      this.enabled = false;
    }
  }

  /** Start a named timer. If already running, logs a warning (helps detect double-fires). */
  start(name: string) {
    if (this.timers.has(name) && this.enabled) {
      const existing = this.timers.get(name)!;
      const elapsed = Math.round(performance.now() - existing.t0);
      console.warn(`[Perf:${name}] ⚠ RESTARTED (was running for ${elapsed}ms with ${existing.marks.length} marks)`);
    }
    this.timers.set(name, { t0: performance.now(), marks: [] });
    try { performance.mark(`perf-${name}-start`); } catch { /* */ }
    if (this.enabled) console.log(`[Perf:${name}] ▶ start`);
  }

  /** Log a checkpoint within a timer. If timer doesn't exist, silently ignore. */
  mark(name: string, label: string) {
    const timer = this.timers.get(name);
    if (!timer) return;
    const elapsed = Math.round(performance.now() - timer.t0);
    timer.marks.push({ label, time: elapsed });
    if (this.enabled) console.log(`[Perf:${name}] ${label}: ${elapsed}ms`);
  }

  /** End a timer and print summary with gap analysis.
   *
   *  "wall" = real elapsed time (performance.now - start)
   *  "accounted" = sum of all gaps between consecutive marks (what we can explain)
   *  "unaccounted" = wall - accounted (time lost between marks, React renders, scheduling, etc.)
   */
  end(name: string) {
    const timer = this.timers.get(name);
    if (!timer) return;
    const wall = Math.round(performance.now() - timer.t0);

    // Independent measurement via Performance API
    let apiWall = -1;
    try {
      performance.mark(`perf-${name}-end`);
      const measure = performance.measure(`perf-${name}`, `perf-${name}-start`, `perf-${name}-end`);
      apiWall = Math.round(measure.duration);
      performance.clearMarks(`perf-${name}-start`);
      performance.clearMarks(`perf-${name}-end`);
      performance.clearMeasures(`perf-${name}`);
    } catch { /* */ }

    if (this.enabled) {
      console.log(`[Perf:${name}] ■ done`);
      // Print timeline with gaps
      let prev = 0;
      for (const m of timer.marks) {
        const gap = m.time - prev;
        console.log(`[Perf:${name}]   ${gap > 50 ? '⚠' : '·'} ${m.label}: +${gap}ms (at ${m.time}ms)`);
        prev = m.time;
      }
      const tail = wall - prev;
      if (tail > 5) {
        console.log(`[Perf:${name}]   ⚠ (after last mark): +${tail}ms`);
      }
      // Summary
      const lastMark = timer.marks.length > 0 ? timer.marks[timer.marks.length - 1].time : 0;
      console.log(`[Perf:${name}]   ── our wall: ${wall}ms | Performance API wall: ${apiWall}ms | delta: ${Math.abs(wall - apiWall)}ms | last mark: ${lastMark}ms | tail: ${tail}ms`);
    }
    this.timers.delete(name);
  }

  /** Get elapsed time for a running timer */
  elapsed(name: string): number {
    const timer = this.timers.get(name);
    return timer ? Math.round(performance.now() - timer.t0) : 0;
  }

  /** Check if a timer is running */
  has(name: string): boolean {
    return this.timers.has(name);
  }
}

export const perfLog = new PerfLog();

// Expose globally for console access
if (typeof window !== 'undefined') {
  (window as unknown as { __perfLog: PerfLog }).__perfLog = perfLog;
}
