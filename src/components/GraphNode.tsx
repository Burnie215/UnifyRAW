/**
 * Single graph-editor node rendered into the SVG canvas.
 *
 * Hit-testing relies on `data-node-id` / `data-port-id` / `data-port-kind`
 * attributes — `GraphEditor`'s pointer handler walks the DOM target up to
 * the nearest matching ancestor to figure out what was clicked.
 */
import type { RenderNode, NodePosition } from '../engine/graph';
import { getMainThreadNodeRegistry, KIND_PREVIEW, LAYOUT_METRICS, nodeKindLabel } from '../engine/graph';

const PREVIEW_THUMB_HEIGHT = 110; // extra body height when this is a preview tap

const CATEGORY_COLOR: Record<string, string> = {
  source:      '#4a9eff', // blue
  decoder:     '#4a9eff',
  adjustment:  '#5cb85c', // green
  convert:     '#888888', // gray
  tap:         '#f5a623', // amber
  mask:        '#9b59b6', // purple
  compositor:  '#e74c3c', // red
  encoder:     '#3498db',
  generator:   '#1abc9c',
};

export interface GraphNodeProps {
  node: RenderNode;
  position: NodePosition;
  selected: boolean;
  /** Blob URL of the rendered preview thumbnail. Only used when node.kind === KIND_PREVIEW. */
  previewUrl?: string;
}

export function GraphNode({ node, position, selected, previewUrl }: GraphNodeProps) {
  const registry = getMainThreadNodeRegistry();
  const kind = registry.get(node.kind);
  const category = kind?.category ?? 'generator';
  const color = CATEGORY_COLOR[category] ?? '#666';
  const inputs = kind?.inputPorts ?? [];
  const outputs = kind?.outputPorts ?? [];
  const { NODE_WIDTH, NODE_HEIGHT, PORT_RADIUS } = LAYOUT_METRICS;
  const isPreview = node.kind === KIND_PREVIEW;
  const bodyHeight = isPreview ? NODE_HEIGHT + PREVIEW_THUMB_HEIGHT : NODE_HEIGHT;

  return (
    <g data-node-id={node.id} transform={`translate(${position.x} ${position.y})`} style={{ cursor: 'grab' }}>
      {/* Body */}
      <rect
        width={NODE_WIDTH}
        height={bodyHeight}
        rx={6}
        fill="rgba(40,40,40,0.9)"
        stroke={selected ? '#fff' : color}
        strokeWidth={selected ? 2 : 1.5}
      />
      {/* Category accent bar (top edge — top-down flow) */}
      <rect width={NODE_WIDTH} height={4} rx={2} fill={color} />
      {/* Title */}
      <text x={12} y={22} fill="#eee" fontSize={12} fontWeight={600} pointerEvents="none">
        {nodeKindLabel(node.kind)}
      </text>
      {/* Subtitle: short id */}
      <text x={12} y={38} fill="#888" fontSize={9} pointerEvents="none">
        {shortId(node.id)}
      </text>

      {/* Preview-tap thumbnail (when rendered) */}
      {isPreview && (
        <g pointerEvents="none">
          <rect x={8} y={NODE_HEIGHT - 4} width={NODE_WIDTH - 16} height={PREVIEW_THUMB_HEIGHT - 4}
            rx={3} fill="#111" stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
          {previewUrl ? (
            <image x={8} y={NODE_HEIGHT - 4} width={NODE_WIDTH - 16} height={PREVIEW_THUMB_HEIGHT - 4}
              href={previewUrl} preserveAspectRatio="xMidYMid meet" />
          ) : (
            <text x={NODE_WIDTH / 2} y={NODE_HEIGHT + (PREVIEW_THUMB_HEIGHT - 4) / 2}
              textAnchor="middle" fontSize={10} fill="#666">
              wird gerendert…
            </text>
          )}
        </g>
      )}

      {/* Input ports (top edge — top-down flow) */}
      {inputs.map((port, idx) => {
        const cx = (NODE_WIDTH / (inputs.length + 1)) * (idx + 1);
        return (
          <g key={`in-${port.id}`} data-port-id={port.id} data-port-kind="in">
            <circle cx={cx} cy={0} r={PORT_RADIUS} fill={portFill(port.type)} stroke="#222" strokeWidth={1} />
            <title>{port.id} · {port.type}{port.multiplicity === 'many' ? ' (optional/many)' : ''}</title>
            {inputs.length > 1 && (
              <text x={cx} y={PORT_RADIUS + 12} fill="#aaa" fontSize={9}
                textAnchor="middle" pointerEvents="none">
                {port.id}
              </text>
            )}
          </g>
        );
      })}

      {/* Output ports (bottom edge — top-down flow) */}
      {outputs.map((port, idx) => {
        const cx = (NODE_WIDTH / (outputs.length + 1)) * (idx + 1);
        return (
          <g key={`out-${port.id}`} data-port-id={port.id} data-port-kind="out">
            <circle cx={cx} cy={bodyHeight} r={PORT_RADIUS} fill={portFill(port.type)} stroke="#222" strokeWidth={1} />
            <title>{port.id} · {port.type}</title>
            {outputs.length > 1 && (
              <text x={cx} y={bodyHeight - PORT_RADIUS - 4} fill="#aaa" fontSize={9}
                textAnchor="middle" pointerEvents="none">
                {port.id}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

function portFill(type: string): string {
  switch (type) {
    case 'color': return '#5cb85c';
    case 'mask':  return '#9b59b6';
    case 'geometry': return '#f5a623';
    case 'meta': return '#999';
    default: return '#666';
  }
}

function shortId(id: string): string {
  return id.length > 30 ? id.slice(0, 12) + '…' + id.slice(-12) : id;
}
