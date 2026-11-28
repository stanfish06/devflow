import { applyNodeChanges, type OnMove, type OnNodesChange, ReactFlow, ReactFlowProvider, useReactFlow, type Viewport } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './workflow-graph.css'
import { Expand, Scan, ZoomIn, ZoomOut } from 'lucide-react'
import { type FC, useCallback, useMemo, useRef, useState } from 'react'
import { useMountEffect } from '../../hooks/use-mount-effect'
import { Button } from '../button'
import { Dialog, DialogContent, DialogTitle } from '../dialog'
import { ArtifactEdge } from './artifact-edge'
import { AutoAdvanceEdge } from './auto-advance-edge'
import { computeLayout, defaultWorkflowPhases, snakeCellSize, snakeColumnCount } from './layout-lite'
import { PhasePlaceholderNode, SessionNode } from './phase-node-lite'
import type {
  ArtifactFlow,
  LayoutDirection,
  WorkflowGraphProps,
  WorkflowGraphNode,
} from './types-lite'
import { snapViewportToDevicePixels } from './viewport'

const nodeTypes = { session: SessionNode, phasePlaceholder: PhasePlaceholderNode }
const edgeTypes = { artifact: ArtifactEdge, autoAdvance: AutoAdvanceEdge }

function getFitViewPadding(direction: LayoutDirection, isStatic?: boolean): number {
  if (isStatic && direction === 'TB') return 0.14
  if (isStatic) return 0.06
  return 0.02
}

const emptyFlows: ArtifactFlow[] = []

const WorkflowGraphInner: FC<WorkflowGraphProps & { onOpenFullscreen?: () => void }> = ({
  sessions,
  artifactFlows = emptyFlows,
  direction = 'snake',
  selectedNodeId,
  focusCurrentStage,
  attentionNodeId,
  autoAdvanceEdges,
  phases = defaultWorkflowPhases,
  static: isStatic,
  compactStaticPreview,
  onSessionClick,
  onPhaseClick,
  onArtifactClick,
  showFullscreenButton = true,
  controlsLayout = 'horizontal',
  controlsPosition = 'bottom-right',
  onOpenFullscreen,
  className,
}) => {
  // Store callbacks in refs so they never cause edge/node recomputation
  const onArtifactClickRef = useRef(onArtifactClick)
  onArtifactClickRef.current = onArtifactClick

  // The pane's size, measured below; the snake layout picks its column count from it.
  const [paneSize, setPaneSize] = useState({ width: 0, height: 0 })
  const snakeCell = useMemo(
    () => snakeCellSize(sessions, phases, isStatic, compactStaticPreview),
    [sessions, phases, isStatic, compactStaticPreview],
  )
  const snakeColumns =
    direction === 'snake' ? snakeColumnCount(phases.length, paneSize.width, paneSize.height, snakeCell) : undefined
  const layout = useMemo(
    () =>
      computeLayout(sessions, artifactFlows, direction, autoAdvanceEdges, phases, isStatic, compactStaticPreview, snakeColumns),
    [sessions, artifactFlows, direction, autoAdvanceEdges, phases, isStatic, compactStaticPreview, snakeColumns],
  )
  const currentSession = sessions.find((session) => session.isCurrentStage)
  const currentPhase = phases.find((phase) => phase.name === currentSession?.labelName)
  const [fitAllStages, setFitAllStages] = useState(false)
  const initialFitNodes = useMemo(() => {
    if (fitAllStages || !focusCurrentStage || !currentPhase) return undefined
    const index = phases.indexOf(currentPhase)
    const nearby = phases.slice(Math.max(0, index - 1), index + 2)
    return layout.nodes.filter(({ data }) =>
      nearby.some((phase) => phase.name === (data.kind === 'session' ? data.session.labelName : data.labelName)),
    )
  }, [fitAllStages, focusCurrentStage, currentPhase, phases, layout.nodes])

  // Structural fingerprint of everything that affects node *positions* (the node
  // and edge set + direction), deliberately excluding styling-only fields like
  // status. Used as the ReactFlow `key` so the graph remounts and refits only on
  // genuine layout changes, and to reset user-dragged positions at the same time.
  const structureKey = useMemo(() => {
    const s = sessions
      .map((session) => `${session.id}:${session.labelName}`)
      .sort()
      .join('|')
    const f = artifactFlows
      .map((flow) => `${flow.fromSessionId}->${flow.toSessionId}:${flow.fileName}`)
      .sort()
      .join('|')
    const a = (autoAdvanceEdges ?? [])
      .map((edge) => `${edge.fromLabel}->${edge.toLabel}`)
      .sort()
      .join('|')
    const p = (phases ?? []).map((phase) => `${phase.name}:${phase.synthetic ? 'synthetic' : 'phase'}`).join('|')
    return `${s};;${f};;${a};;${p};;${direction}${snakeColumns ?? ''};;${isStatic ? 'static' : 'interactive'};;${compactStaticPreview ? 'compact' : 'default'}`
  }, [sessions, artifactFlows, autoAdvanceEdges, phases, direction, snakeColumns, isStatic, compactStaticPreview])

  const [viewportState, setViewportState] = useState<{
    structureKey: string
    viewport?: Viewport
  }>({ structureKey })
  const viewport = viewportState.structureKey === structureKey ? viewportState.viewport : undefined
  const handleViewportChange = useCallback((nextViewport: Viewport) => {
    setViewportState({ structureKey, viewport: nextViewport })
  }, [structureKey])
  const handleMoveEnd = useCallback<OnMove>((_event, nextViewport) => {
    const pixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio
    setViewportState({
      structureKey,
      viewport: snapViewportToDevicePixels(nextViewport, pixelRatio),
    })
  }, [structureKey])

  // Stable callback that reads from ref — never changes identity
  const handleArtifactClick = useCallback((fileName: string, source: string, target: string) => {
    onArtifactClickRef.current?.(fileName, source, target)
  }, [])

  // Edge label hover highlight — dims everything except the hovered edge and its connected nodes
  const [hoveredEdge, setHoveredEdge] = useState<{ source: string; target: string } | null>(null)

  const handleEdgeLabelEnter = useCallback((source: string, target: string) => {
    setHoveredEdge({ source, target })
  }, [])

  const handleEdgeLabelLeave = useCallback(() => {
    setHoveredEdge(null)
  }, [])

  // Edges only recompute when layout.edges changes (not on callback changes)
  const edgesWithCallbacks = useMemo(() => {
    return layout.edges.map((edge) => {
      if (edge.type === 'artifact' && edge.data) {
        return {
          ...edge,
          data: {
            ...edge.data,
            onArtifactClick: (fileName: string) =>
              handleArtifactClick(fileName, edge.source, edge.target),
            onEdgeLabelHover: () => handleEdgeLabelEnter(edge.source, edge.target),
            onEdgeLabelLeave: handleEdgeLabelLeave,
          },
        }
      }
      return edge
    })
  }, [layout.edges, handleArtifactClick, handleEdgeLabelEnter, handleEdgeLabelLeave])

  const nodesWithSelection = useMemo(() => {
    return layout.nodes.map((node) => ({
      ...node,
      selected: node.id === selectedNodeId,
      data: {
        ...node.data,
        ...(node.data.kind === 'session' && !node.data.synthetic && { onOpen: onSessionClick }),
        attention: node.id === attentionNodeId,
      },
    }))
  }, [layout.nodes, selectedNodeId, attentionNodeId, onSessionClick])

  const { fitView: rfFitView, fitBounds: rfFitBounds, zoomIn: rfZoomIn, zoomOut: rfZoomOut } = useReactFlow()
  const fitViewPadding = getFitViewPadding(direction, isStatic)
  // Interactive graphs should fill the canvas on fit; static previews keep their
  // deliberate (maxZoom 1) sizing. fitView never zooms past what's needed to fit
  // all nodes, so this just lifts the artificial clamp that was leaving slack.
  const fitMaxZoom = isStatic ? 1 : 2
  const containerRef = useRef<HTMLDivElement>(null)

  const [nodeState, setNodeState] = useState<{
    structureKey: string
    baseNodes: WorkflowGraphNode[]
    nodes: WorkflowGraphNode[]
  }>(() => ({ structureKey, baseNodes: nodesWithSelection, nodes: nodesWithSelection }))

  let nodes = nodeState.nodes
  if (nodeState.baseNodes !== nodesWithSelection) {
    const structureChanged = nodeState.structureKey !== structureKey
    const prevById = new Map(nodeState.nodes.map((node) => [node.id, node]))
    nodes = structureChanged
      ? nodesWithSelection
      : nodesWithSelection.map((node) => {
          const existing = prevById.get(node.id)
          return existing ? { ...node, position: existing.position, dragging: existing.dragging } : node
        })
    setNodeState({ structureKey, baseNodes: nodesWithSelection, nodes })
  }

  const onNodesChange = useCallback<OnNodesChange<WorkflowGraphNode>>((changes) => {
    setNodeState((current) => ({ ...current, nodes: applyNodeChanges(changes, current.nodes) }))
  }, [])

  // The whole graph: the layout's bounds when it routes edges outside the cards, else the nodes.
  const layoutBounds = layout.bounds
  const fitAll = useCallback(
    (duration: number) => {
      if (layoutBounds) rfFitBounds(layoutBounds, { padding: fitViewPadding, duration })
      else rfFitView({ maxZoom: fitMaxZoom, padding: fitViewPadding, duration })
    },
    [rfFitBounds, rfFitView, layoutBounds, fitViewPadding, fitMaxZoom],
  )

  const fitToViewport = useCallback(() => {
    requestAnimationFrame(() => {
      if (initialFitNodes) {
        rfFitView({ nodes: initialFitNodes, maxZoom: fitMaxZoom, padding: fitViewPadding, duration: 0 })
      } else fitAll(0)
    })
  }, [rfFitView, fitAll, fitViewPadding, fitMaxZoom, initialFitNodes])

  // Manual "fit to view" toolbar action — animated to match the zoom buttons.
  const handleFitView = useCallback(() => {
    setFitAllStages(true)
    fitAll(200)
  }, [fitAll])

  // Keep the graph fitted as the window / container resizes. fitToViewport's
  // identity changes with padding/zoom, so the subscriptions read the latest
  // via a ref and only need to attach once.
  const fitToViewportRef = useRef(fitToViewport)
  fitToViewportRef.current = fitToViewport

  useMountEffect(() => {
    if (typeof window === 'undefined') return
    const handleResize = () => fitToViewportRef.current()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  })

  useMountEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const resizeObserver = new ResizeObserver(([entry]) => {
      if (entry) {
        const width = Math.round(entry.contentRect.width)
        const height = Math.round(entry.contentRect.height)
        setPaneSize((size) => (size.width === width && size.height === height ? size : { width, height }))
      }
      fitToViewportRef.current()
    })
    resizeObserver.observe(el)
    return () => resizeObserver.disconnect()
  })

  return (
    <div
      className={`wf-graph relative flex flex-col ${className ?? ''} ${hoveredEdge ? 'edge-highlight-active' : ''}`.trim()}
      style={{
        width: '100%',
        height: '100%',
        '--xy-background-color': 'transparent',
        '--xy-node-border-radius': '0',
        '--xy-node-boxshadow-hover': 'none',
        '--xy-node-boxshadow-selected': 'none',
      } as React.CSSProperties}
    >
      {currentPhase && (
        <div className="shrink-0 px-2 py-1 text-xs">
          Current stage <strong>{currentPhase.title}</strong>
        </div>
      )}
      <div ref={containerRef} className="relative min-h-0 flex-1">
        {hoveredEdge && (
          <style>{`
            .edge-highlight-active .react-flow__node { opacity: 0.3; }
            .edge-highlight-active .react-flow__node[data-id="${hoveredEdge.source}"],
            .edge-highlight-active .react-flow__node[data-id="${hoveredEdge.target}"] { opacity: 1; }
            .edge-highlight-active .react-flow__edge path { opacity: 0.15; }
            .edge-highlight-active .react-flow__edgelabel-renderer button { opacity: 0.3; }
          `}</style>
        )}
        <ReactFlow
          key={structureKey}
          viewport={viewport}
          onViewportChange={handleViewportChange}
          onMoveEnd={handleMoveEnd}
          nodes={nodes}
          edges={edgesWithCallbacks}
          onNodesChange={onNodesChange}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={(_event, node) => {
            if (node.data.synthetic) return
            if (node.data.kind === 'phase') onPhaseClick?.(node.data.labelName)
            if (node.data.kind === 'session') onSessionClick?.(node.data.session.id)
          }}
          fitView
          fitViewOptions={{ nodes: initialFitNodes, maxZoom: fitMaxZoom, padding: fitViewPadding }}
          minZoom={0.2}
          maxZoom={2}
          nodesDraggable={true}
          nodesConnectable={false}
          elementsSelectable={true}
          proOptions={{ hideAttribution: true }}
        />
        <div
          className={`absolute right-2 z-10 flex gap-1 ${
            controlsPosition === 'header-right'
              ? '-top-4'
              : controlsPosition === 'top-right'
                ? 'top-2'
                : 'bottom-2'
          } ${
            controlsLayout === 'vertical-fullscreen-first' ? 'flex-col' : 'items-center'
          }`}
        >
          {showFullscreenButton && onOpenFullscreen && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 bg-background/80 hover:bg-background"
              aria-label="Expand workflow graph"
              onClick={(e) => {
                e.stopPropagation()
                onOpenFullscreen()
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <Expand className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 bg-background/80 hover:bg-background"
            aria-label="Fit workflow graph"
            onClick={handleFitView}
          >
            <Scan className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 bg-background/80 hover:bg-background"
            aria-label="Zoom in"
            onClick={() => rfZoomIn({ duration: 200 })}
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 bg-background/80 hover:bg-background"
            aria-label="Zoom out"
            onClick={() => rfZoomOut({ duration: 200 })}
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}

export const WorkflowGraphLite: FC<WorkflowGraphProps> = (props) => {
  const [isFullscreenOpen, setIsFullscreenOpen] = useState(false)
  const { fullscreenDirection, showFullscreenButton = true } = props

  return (
    <>
      <ReactFlowProvider>
        <WorkflowGraphInner
          {...props}
          onOpenFullscreen={showFullscreenButton ? () => setIsFullscreenOpen(true) : undefined}
        />
      </ReactFlowProvider>

		<Dialog open={isFullscreenOpen} onOpenChange={setIsFullscreenOpen}>
			<DialogContent
				className="!max-w-[95vw] !w-[95vw] !h-[85vh] !p-4 !gap-0 overflow-hidden [&>button]:z-20"
				onEscapeKeyDown={(e) => e.stopPropagation()}
			>
          <DialogTitle className="sr-only">Workflow graph</DialogTitle>
          <ReactFlowProvider>
            <WorkflowGraphInner
              {...props}
              onSessionClick={props.onSessionClick && ((id) => {
                setIsFullscreenOpen(false)
                props.onSessionClick?.(id)
              })}
              direction={fullscreenDirection ?? props.direction}
              focusCurrentStage={false}
              controlsLayout="horizontal"
              controlsPosition="bottom-right"
              showFullscreenButton={false}
            />
          </ReactFlowProvider>
        </DialogContent>
      </Dialog>
    </>
  )
}

export type { WorkflowGraphProps }
