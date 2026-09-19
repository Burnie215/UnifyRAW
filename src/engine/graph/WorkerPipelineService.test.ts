/**
 * Worker-protocol tests with an in-process stub Worker (no real GL).
 *
 * Covers (D6/Worker-Crash-Test):
 *   1. round-trip: request → response demultiplex by id
 *   2. error response rejects the awaiting promise
 *   3. worker `error` event surfaces to every in-flight caller
 *   4. release() terminates and blocks further calls
 *
 * Real GL-backed protocol coverage lives in the browser project
 * (PipelineService.browser.test.ts) where an actual worker can spawn.
 */
import { describe, expect, it, vi } from 'vitest';
import { WorkerPipelineService } from './WorkerPipelineService';
import type { WorkerRequest, WorkerResponse, PlanHandle } from './workerProtocol';

class StubWorker {
  private listeners = new Map<string, Set<(ev: Event) => void>>();
  private requests: WorkerRequest[] = [];
  terminated = false;
  postMessage = vi.fn((data: WorkerRequest) => {
    this.requests.push(data);
    const handler = this.onMessage;
    if (handler) handler(data);
  });
  terminate = vi.fn(() => { this.terminated = true; });

  addEventListener(type: string, fn: (ev: Event) => void): void {
    let set = this.listeners.get(type);
    if (!set) { set = new Set(); this.listeners.set(type, set); }
    set.add(fn);
  }
  removeEventListener(type: string, fn: (ev: Event) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  dispatchEvent(_ev: Event): boolean { return true; }

  /** Test hook: set by the test to react synchronously to each postMessage. */
  onMessage: ((req: WorkerRequest) => void) | null = null;

  /** Fire a response back to the main-thread client. */
  respond(resp: WorkerResponse): void {
    const set = this.listeners.get('message');
    if (!set) return;
    const ev = { data: resp } as MessageEvent<WorkerResponse>;
    for (const fn of set) fn(ev as unknown as Event);
  }

  /** Fire a worker-level error to all listeners. */
  fireError(message: string): void {
    const set = this.listeners.get('error');
    if (!set) return;
    const ev = { message } as ErrorEvent;
    for (const fn of set) fn(ev as unknown as Event);
  }

  lastRequest(): WorkerRequest | undefined { return this.requests[this.requests.length - 1]; }
}

function makeService(): { svc: WorkerPipelineService; stub: StubWorker } {
  const stub = new StubWorker();
  const svc = new WorkerPipelineService(stub as unknown as Worker);
  return { svc, stub };
}

describe('WorkerPipelineService (stub worker)', () => {
  it('routes responses back to the awaiting caller by id', async () => {
    const { svc, stub } = makeService();
    const expected: PlanHandle = { planId: 'plan-1', graphRevision: 1, terminalGeometry: null };
    stub.onMessage = (req) => {
      stub.respond({ id: req.id, ok: true, op: 'compile', result: expected });
    };
    const handle = await svc.compile({
      id: 'g', nodes: new Map(), edges: [], output: '',
      metadata: { createdAt: 0, updatedAt: 0, revision: 1 },
    });
    expect(handle).toEqual(expected);
  });

  it('demultiplexes interleaved responses', async () => {
    const { svc, stub } = makeService();
    const replies: WorkerResponse[] = [];
    stub.onMessage = (req) => {
      // Respond in reverse order to verify the demux is id-based.
      replies.push({ id: req.id, ok: true, op: 'releasePlan', result: null });
    };
    const p1 = svc.releasePlan({ planId: 'a', graphRevision: 0, terminalGeometry: null });
    const p2 = svc.releasePlan({ planId: 'b', graphRevision: 0, terminalGeometry: null });
    // Send replies out of order: the second request first, then the first.
    stub.respond(replies[1]);
    stub.respond(replies[0]);
    await expect(p1).resolves.toBeUndefined();
    await expect(p2).resolves.toBeUndefined();
  });

  it('rejects the calling promise on an error response', async () => {
    const { svc, stub } = makeService();
    stub.onMessage = (req) => {
      stub.respond({ id: req.id, ok: false, error: 'boom' });
    };
    await expect(svc.clearPlanCache()).rejects.toThrow('boom');
  });

  it('keeps Uint16 pixels on the dedicated readback protocol operation', async () => {
    const { svc, stub } = makeService();
    const pixels = new Uint16Array([0, 1234, 45678, 65535]);
    stub.onMessage = (req) => {
      expect(req.op).toBe('renderToPixels16');
      stub.respond({
        id: req.id,
        ok: true,
        op: 'renderToPixels16',
        result: { width: 1, height: 1, pixels },
      });
    };

    const result = await svc.renderToPixels16(
      { planId: 'p16', graphRevision: 1, terminalGeometry: { width: 1, height: 1, pixelRatio: 1 } },
      'source',
    );
    expect(result.pixels).toBeInstanceOf(Uint16Array);
    expect([...result.pixels]).toEqual([0, 1234, 45678, 65535]);
  });

  it('surfaces worker `error` events to every in-flight caller and clears them', async () => {
    const { svc, stub } = makeService();
    // Don't reply — leave callers in-flight.
    stub.onMessage = null;
    const p1 = svc.releasePlan({ planId: 'a', graphRevision: 0, terminalGeometry: null });
    const p2 = svc.clearPlanCache();
    stub.fireError('worker crashed mid-flight');
    await expect(p1).rejects.toThrow(/worker crashed mid-flight/);
    await expect(p2).rejects.toThrow(/worker crashed mid-flight/);
    // Pending map cleared — a fresh call after the crash still works
    // (the client doesn't auto-respawn but the next postMessage doesn't
    // re-attach to the cleared pending entries).
    stub.onMessage = (req) => {
      stub.respond({ id: req.id, ok: true, op: 'clearPlanCache', result: null });
    };
    await expect(svc.clearPlanCache()).resolves.toBeUndefined();
  });

  it('release() terminates the worker and rejects further calls', async () => {
    const { svc, stub } = makeService();
    stub.onMessage = (req) => {
      stub.respond({ id: req.id, ok: true, op: 'release', result: null });
    };
    await svc.release();
    expect(stub.terminate).toHaveBeenCalled();
    await expect(svc.clearPlanCache()).rejects.toThrow(/already released/);
  });
});
