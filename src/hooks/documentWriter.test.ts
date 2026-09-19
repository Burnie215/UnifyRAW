import { describe, expect, it } from 'vitest';
import { createDocument, type PhotoDocument, type SerializedGraph } from '../engine/DocumentModel';
import { createDocumentWriter } from './documentWriter';

const GRAPH: SerializedGraph = {
  id: 'g', nodes: [], edges: [], output: 'out',
  metadata: { createdAt: 0, updatedAt: 0, revision: 0 },
};

function recordingWriter(initial: PhotoDocument = createDocument()) {
  const calls: { next: PhotoDocument; prev: PhotoDocument }[] = [];
  const writer = createDocumentWriter(initial, (next, prev) => calls.push({ next, prev }));
  return { writer, calls, initial };
}

describe('createDocumentWriter', () => {
  it('keeps both fields when two updaters write in the same handler', () => {
    const { writer, calls } = recordingWriter();

    writer.write((p) => ({ ...p, pipelineMode: 'graph' }));
    writer.write((p) => ({ ...p, pipelineGraph: GRAPH }));

    const last = calls.at(-1)!.next;
    expect(last.pipelineMode).toBe('graph');
    expect(last.pipelineGraph).toBe(GRAPH);
    expect(calls).toHaveLength(2);
  });

  it('shows a write to the next read in the same tick', () => {
    const { writer, initial } = recordingWriter();

    const written = writer.write((p) => ({ ...p, pipelineMode: 'graph' }));

    expect(writer.current).toBe(written);
    expect(writer.current).not.toBe(initial);
    expect(writer.current.pipelineMode).toBe('graph');
  });

  it('hands the sink the document the write started from', () => {
    const { writer, calls, initial } = recordingWriter();

    const first = writer.write((p) => ({ ...p, pipelineMode: 'graph' }));
    writer.write((p) => ({ ...p, pipelineGraph: GRAPH }));

    expect(calls[0].prev).toBe(initial);
    expect(calls[1].prev).toBe(first);
  });

  it('writes a finished document through as well', () => {
    const { writer, calls } = recordingWriter();
    const next: PhotoDocument = { ...createDocument(), pipelineMode: 'graph' };

    writer.write(next);

    expect(writer.current).toBe(next);
    expect(calls.map((c) => c.next)).toEqual([next]);
  });

  it('writes nothing when the updater hands prev back', () => {
    const { writer, calls, initial } = recordingWriter();

    const result = writer.write((p) => p);

    expect(result).toBe(initial);
    expect(writer.current).toBe(initial);
    expect(calls).toHaveLength(0);
  });

  it('adopts a replaced document without a sink call, and the next updater starts from it', () => {
    const { writer, calls } = recordingWriter();
    const loaded: PhotoDocument = { ...createDocument(), pipelineMode: 'graph' };

    writer.replace(loaded);
    expect(calls).toHaveLength(0);
    expect(writer.current).toBe(loaded);

    writer.write((p) => ({ ...p, pipelineGraph: GRAPH }));
    expect(calls[0].prev).toBe(loaded);
    expect(calls[0].next.pipelineMode).toBe('graph');
    expect(calls[0].next.pipelineGraph).toBe(GRAPH);
  });
});
