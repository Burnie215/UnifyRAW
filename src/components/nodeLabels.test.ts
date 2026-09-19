/**
 * One name per node kind, everywhere.
 *
 * The node body, the inspector header, the library row and the output rail
 * each carried their own `prettyName`, in two spellings: two capitalised the
 * first letter and two did not, so the same kind read "Tone" on the node and
 * "tone" in the inspector (F094). `nodeKindLabel` in the projection's chain
 * rules is the one that the blocking reasons already used; the four copies are
 * gone and this file is what keeps a fifth from growing back.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { nodeKindLabel } from '../engine/graph';

const COMPONENTS = path.dirname(fileURLToPath(import.meta.url));

/** Every surface that writes a node kind where the user can read it. */
const LABEL_SURFACES = [
  'GraphNode.tsx',
  'NodeInspectorPanel.tsx',
  'NodeLibraryPanel.tsx',
  'SelectedNodeOutputPanel.tsx',
  'GraphEditor.tsx',
];

describe('node kind labels', () => {
  it.each(LABEL_SURFACES)('%s asks the engine instead of spelling the name itself', (file) => {
    const source = readFileSync(path.join(COMPONENTS, file), 'utf8');
    expect(source).toContain('nodeKindLabel');
    expect(source).not.toContain('function prettyName');
    // The camel-case split is the body of such a private copy; a surface that
    // carries it is doing the transformation itself again.
    expect(source).not.toContain("replace(/([A-Z])/g");
  });

  it('gives every surface the same spelling', () => {
    expect(nodeKindLabel('tone')).toBe('Tone');
    expect(nodeKindLabel('whiteBalance')).toBe('White Balance');
    expect(nodeKindLabel('__source.imageBitmap')).toBe('Source · image Bitmap');
  });
});
