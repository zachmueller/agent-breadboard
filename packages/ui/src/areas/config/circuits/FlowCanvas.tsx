/**
 * Circuit flow canvas ([03] §8.1): steps as kind-styled nodes with one source handle per declared
 * exit, one terminal node per circuit exit, a start node marking the entry. Editable mode wires
 * drag-to-connect (sets `exits[].to` / `entry`), delete, and selection; read-only mode is used by
 * the side-by-side diff views.
 */
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Panel,
  Handle,
  Position,
  MarkerType,
  applyNodeChanges,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
  type NodeChange,
  type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Bot, Code2, Workflow, ShieldCheck, Flag, Play, ExternalLink, Plus } from 'lucide-react';
import {
  layoutGraph,
  START_ID,
  NEW_EXIT_HANDLE,
  exitHandleId,
  type GraphNode,
  type GraphEdge,
  type StepNodeData,
  type ExitNodeData,
  type DiffMark,
} from '../lib/circuitGraph';
import { useTreeIndex } from '../lib/configApi';
import { AppLink } from '../components/AppLink';
import { readPositions, writePositions, type Positions } from './positions';

export interface FlowGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const FlowCtx = createContext<{ editable: boolean; errorsByStep: Record<string, number> }>({ editable: false, errorsByStep: {} });

const KIND_META: Record<string, { icon: typeof Bot; label: string; cls: string; ref: string }> = {
  llm: { icon: Bot, label: 'LLM', cls: 'border-accent/50 bg-surface', ref: 'subagent' },
  code: { icon: Code2, label: 'Code', cls: 'border-info/50 bg-surface', ref: 'tool' },
  circuit: { icon: Workflow, label: 'Circuit', cls: 'border-line-strong bg-raised border-double border-[3px]', ref: 'circuit' },
  gate: { icon: ShieldCheck, label: 'Gate', cls: 'border-warn bg-warn-soft rounded-[1.25rem]', ref: '' },
};

const DIFF_RING: Record<Exclude<DiffMark, undefined>, string> = {
  added: 'ring-2 ring-ok ring-offset-1 ring-offset-page',
  removed: 'ring-2 ring-danger ring-offset-1 ring-offset-page opacity-70',
  modified: 'ring-2 ring-warn ring-offset-1 ring-offset-page',
};

const handleCls = '!size-2.5 !border-2 !border-surface';

const StepNodeView = memo(function StepNodeView({ data, selected }: NodeProps<Node<StepNodeData>>) {
  const { editable, errorsByStep } = useContext(FlowCtx);
  const idx = useTreeIndex();
  const meta = KIND_META[data.kind] ?? { icon: Code2, label: data.kind, cls: 'border-danger bg-surface', ref: '' };
  const Icon = meta.icon;
  const refEntry = meta.ref && data.ref ? idx.get(meta.ref, data.ref) : undefined;
  const errs = errorsByStep[data.stepId] ?? 0;
  return (
    <div
      className={clsx(
        'relative min-w-[13rem] max-w-[17rem] rounded-lg border-2 text-left shadow-sm',
        meta.cls,
        selected && 'outline-2 outline-offset-2 outline-accent',
        data.diff && DIFF_RING[data.diff],
      )}
    >
      <Handle type="target" position={Position.Top} className={clsx(handleCls, '!bg-fg-subtle')} isConnectable={editable} />
      <div className="flex items-center gap-1.5 px-2.5 pt-2">
        <Icon className={clsx('size-3.5 shrink-0', data.kind === 'gate' ? 'text-warn-fg' : data.kind === 'code' ? 'text-info-fg' : 'text-accent-text')} />
        <span className="truncate font-mono text-xs font-semibold">{data.stepId}</span>
        {data.isEntry && <span className="rounded bg-accent px-1 text-[9px] font-bold tracking-wide text-accent-fg">ENTRY</span>}
        <span className="ml-auto text-[10px] uppercase text-fg-subtle">{meta.label}</span>
      </div>
      {data.title && <div className="truncate px-2.5 text-xs text-fg-muted">{data.title}</div>}
      {meta.ref && (
        <div className="flex items-center gap-1 px-2.5 pt-0.5 text-[11px]">
          <span className="text-fg-subtle">{meta.ref}:</span>
          <span className={clsx('truncate font-mono', !data.ref ? 'text-danger-fg' : !refEntry && !idx.loading ? 'text-warn-fg' : 'text-fg-muted')} title={data.ref}>
            {refEntry?.slug ?? (data.ref ? `${data.ref.slice(0, 8)}…` : 'unset')}
          </span>
          {data.kind === 'circuit' && data.ref && (
            <AppLink href={`/circuits/${data.ref}`} className="nodrag ml-auto rounded p-0.5 text-accent-text hover:bg-hover" title="Open child circuit">
              <ExternalLink className="size-3" />
            </AppLink>
          )}
        </div>
      )}
      {errs > 0 && <div className="absolute -right-2 -top-2 rounded-full bg-danger px-1.5 text-[10px] font-bold text-white">{errs}</div>}
      <div className="mt-1.5 flex flex-wrap items-end justify-center gap-1 border-t border-line/70 px-1.5 pb-2.5 pt-1.5">
        {data.exits.map((x) => (
          <div
            key={x.name}
            className={clsx(
              'relative rounded px-1.5 py-0.5 font-mono text-[10px]',
              x.dangling ? 'bg-danger-soft text-danger-fg' : x.name === 'approve' ? 'bg-ok-soft text-ok-fg' : x.name === 'changes' ? 'bg-warn-soft text-warn-fg' : 'bg-sunken text-fg-muted',
            )}
            title={x.dangling ? `exit '${x.name}' has no valid target` : `${x.name} → ${x.to}`}
          >
            {x.name}
            <Handle id={exitHandleId(x.name)} type="source" position={Position.Bottom} className={clsx(handleCls, x.dangling ? '!bg-danger' : '!bg-accent')} isConnectable={editable} />
          </div>
        ))}
        {editable && (
          <div className="relative rounded border border-dashed border-line-strong px-1 py-0.5 text-[10px] text-fg-subtle" title="Drag to add an exit">
            <Plus className="size-2.5" />
            <Handle id={NEW_EXIT_HANDLE} type="source" position={Position.Bottom} className={clsx(handleCls, '!bg-fg-subtle')} />
          </div>
        )}
      </div>
    </div>
  );
});

const ExitNodeView = memo(function ExitNodeView({ data, selected }: NodeProps<Node<ExitNodeData>>) {
  const { editable } = useContext(FlowCtx);
  return (
    <div
      className={clsx(
        'flex min-w-[7rem] items-center justify-center gap-1.5 rounded-full border-2 px-3 py-1.5 text-xs font-semibold shadow-sm',
        data.unreachable ? 'border-dashed border-line-strong bg-sunken text-fg-subtle' : 'border-ok bg-ok-soft text-ok-fg',
        selected && 'outline-2 outline-offset-2 outline-accent',
        data.diff && DIFF_RING[data.diff],
      )}
      title={data.unreachable ? 'No step routes to this exit' : data.description}
    >
      <Handle type="target" position={Position.Top} className={clsx(handleCls, '!bg-ok')} isConnectable={editable} />
      <Flag className="size-3" />
      <span className="font-mono">{data.exitName}</span>
    </div>
  );
});

const StartNodeView = memo(function StartNodeView({ selected }: NodeProps) {
  const { editable } = useContext(FlowCtx);
  return (
    <div className={clsx('flex size-10 items-center justify-center rounded-full border-2 border-accent bg-accent text-accent-fg shadow-sm', selected && 'outline-2 outline-offset-2 outline-accent')} title="Start (drag to set the entry step)">
      <Play className="size-4" />
      <Handle id="start" type="source" position={Position.Bottom} className={clsx(handleCls, '!bg-accent')} isConnectable={editable} />
    </div>
  );
});

const nodeTypes = { step: StepNodeView, exit: ExitNodeView, start: StartNodeView };

const TONE_STROKE: Record<GraphEdge['tone'], string> = {
  approve: 'var(--color-ok)',
  changes: 'var(--color-warn)',
  entry: 'var(--color-accent)',
  default: 'var(--color-fg-subtle)',
};
const DIFF_STROKE: Record<Exclude<DiffMark, undefined>, string> = { added: 'var(--color-ok)', removed: 'var(--color-danger)', modified: 'var(--color-warn)' };

function toRfEdges(edges: GraphEdge[], selected: Set<string>): Edge[] {
  return edges.map((e) => {
    const stroke = e.diff ? DIFF_STROKE[e.diff] : TONE_STROKE[e.tone];
    return {
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      label: e.tone === 'entry' ? undefined : e.label,
      type: e.loop ? 'smoothstep' : 'default',
      selected: selected.has(e.id),
      deletable: e.tone !== 'entry',
      animated: e.tone === 'entry',
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 16, height: 16 },
      style: { stroke, strokeWidth: e.tone === 'default' ? 1.5 : 2, strokeDasharray: e.diff === 'removed' ? '5 4' : e.loop ? '6 3' : undefined },
      labelStyle: { fontSize: 10, fontFamily: 'var(--font-mono, monospace)', fill: 'var(--color-fg-muted)' },
      labelBgStyle: { fill: 'var(--color-surface)' },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 3,
    };
  });
}

export interface FlowCanvasProps {
  graph: FlowGraph;
  /** Circuit uid for persisted positions (editable canvases). */
  uid?: string;
  editable?: boolean;
  selectedId?: string | null;
  onSelect?: (nodeId: string | null) => void;
  onConnect?: (source: string, sourceHandle: string, target: string) => void;
  onDeleteEdges?: (edgeIds: string[]) => void;
  onDeleteNodes?: (nodeIds: string[]) => void;
  errorsByStep?: Record<string, number>;
  toolbar?: ReactNode;
  className?: string;
  /** Positions to prefer (diff views reuse the editor's stored layout). */
  positionsFrom?: string;
}

export function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function FlowCanvasInner({ graph, uid, editable = false, selectedId, onSelect, onConnect, onDeleteEdges, onDeleteNodes, errorsByStep = {}, toolbar, className, positionsFrom }: FlowCanvasProps) {
  const rf = useReactFlow();
  const posUid = uid ?? positionsFrom;
  const [stored, setStored] = useState<Positions>(() => readPositions(posUid));
  useEffect(() => {
    setStored(readPositions(posUid));
    const on = (e: Event) => (e as CustomEvent).detail === posUid && setStored(readPositions(posUid));
    window.addEventListener('bb:circuit-positions', on);
    return () => window.removeEventListener('bb:circuit-positions', on);
  }, [posUid]);

  const auto = useMemo(() => layoutGraph(graph.nodes, graph.edges), [graph]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [selEdges, setSelEdges] = useState<Set<string>>(new Set());

  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return graph.nodes.map((n) => {
        const p = prevById.get(n.id);
        const position = stored[n.id] ?? auto[n.id] ?? { x: 0, y: 0 };
        return {
          id: n.id,
          type: n.data.type,
          data: n.data,
          position: p?.dragging ? p.position : position,
          selected: selectedId !== undefined ? selectedId === n.id : (p?.selected ?? false),
          deletable: editable && n.id !== START_ID,
          draggable: true,
          connectable: editable,
        } satisfies Node;
      });
    });
  }, [graph, auto, stored, selectedId, editable]);

  const edges = useMemo(() => toRfEdges(graph.edges, selEdges), [graph.edges, selEdges]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== 'remove'), ns));
    },
    [],
  );

  const persistDrag = useCallback(
    (_: unknown, node: Node, dragged?: Node[]) => {
      if (!uid) return;
      const next = { ...readPositions(uid) };
      for (const n of dragged?.length ? dragged : [node]) next[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
      writePositions(uid, next);
    },
    [uid],
  );

  const handleConnect = useCallback(
    (c: Connection) => {
      if (!editable || !onConnect || !c.source || !c.target || !c.sourceHandle) return;
      if (c.target === START_ID || c.source === c.target && c.sourceHandle === 'start') return;
      onConnect(c.source, c.sourceHandle, c.target);
    },
    [editable, onConnect],
  );

  const relayout = () => {
    if (uid) writePositions(uid, {});
    setTimeout(() => rf.fitView({ padding: 0.15, duration: 250 }), 30);
  };

  useEffect(() => {
    const t = setTimeout(() => rf.fitView({ padding: 0.15 }), 50);
    return () => clearTimeout(t);
    // fit once per mounted graph identity set
  }, [graph.nodes.length]);

  return (
    <FlowCtx.Provider value={{ editable, errorsByStep }}>
      <div className={clsx('h-full w-full', className)}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          colorMode="system"
          onNodesChange={onNodesChange}
          onNodeDragStop={persistDrag}
          onSelectionDragStop={(e, ns) => ns[0] && persistDrag(e, ns[0], ns)}
          onConnect={handleConnect}
          isValidConnection={(c) => c.target !== START_ID && c.source !== c.target}
          onNodeClick={(_, n) => onSelect?.(n.id)}
          onPaneClick={() => {
            onSelect?.(null);
            setSelEdges(new Set());
          }}
          onEdgeClick={(_, e) => setSelEdges(new Set([e.id]))}
          onNodesDelete={(ns) => editable && onDeleteNodes?.(ns.map((n) => n.id).filter((id) => id !== START_ID))}
          onEdgesDelete={(es) => {
            if (!editable) return;
            setSelEdges(new Set());
            onDeleteEdges?.(es.map((e) => e.id).filter((id) => id !== 'e:start'));
          }}
          deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
          nodesConnectable={editable}
          edgesFocusable={editable}
          elementsSelectable
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} size={1} color="var(--color-chart-grid)" />
          <Controls showInteractive={false} position="bottom-left" />
          {(toolbar || editable) && (
            <Panel position="top-left" className="flex gap-1">
              {toolbar}
              {editable && uid && (
                <button type="button" onClick={relayout} className="h-7 rounded-md border border-line bg-surface px-2 text-xs text-fg-muted shadow-sm hover:bg-hover">
                  Auto-layout
                </button>
              )}
            </Panel>
          )}
        </ReactFlow>
      </div>
    </FlowCtx.Provider>
  );
}
