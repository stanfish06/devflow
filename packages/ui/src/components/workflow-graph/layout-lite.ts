import { Position, type Edge } from '@xyflow/react'
import { RPI_LABELS } from '../../constants/rpi-skills'
import type {
  ArtifactFlow,
  AutoAdvanceEdge,
  LayoutDirection,
  WorkflowGraphNode,
  WorkflowPhase,
  WorkflowSession,
} from './types-lite'

export const defaultWorkflowPhases: WorkflowPhase[] = RPI_LABELS.filter((label) => label.name !== 'rpi:todo')

const SESSION_NODE_WIDTH = 170
const SESSION_NODE_HEIGHT = 90
const PLACEHOLDER_NODE_WIDTH = 90
const PLACEHOLDER_NODE_HEIGHT = 28
const STATIC_PLACEHOLDER_NODE_WIDTH = 280
const STATIC_PLACEHOLDER_NODE_HEIGHT = 88
const COMPACT_STATIC_PLACEHOLDER_NODE_WIDTH = 128
const COMPACT_STATIC_PLACEHOLDER_NODE_HEIGHT = 40

/** Spacing between phase columns (LR) or rows (TB) */
const PHASE_GAP_LR = 32
const PHASE_GAP_TB = 44
const STATIC_PREVIEW_WIDTH = 720
const STATIC_PREVIEW_HEIGHT = 760
/** Spacing between sessions stacked vertically within a phase */
const SESSION_STACK_GAP = 8
/** Spacing between sessions spread horizontally within a phase */
const SESSION_SPREAD_GAP = 16
/** Spacing between snake grid columns and rows */
const SNAKE_GAP_X = 48
const SNAKE_GAP_Y = 44
/** Outer margin */
const MARGIN = 16
/** Clearance above intermediate nodes for routed artifact edges */
const ROUTE_MARGIN = 40
/** Stagger between multiple routed edges */
const ROUTE_STAGGER = 12

export interface LayoutResult {
  nodes: WorkflowGraphNode[]
  edges: Edge[]
}

/** Artifact label size at the 10px mono font ArtifactEdge draws it in, for fitting. */
const LABEL_HEIGHT = 20
const labelWidth = (fileName: string) => fileName.length * 6.5 + 14

export function computeLayout(
  sessions: WorkflowSession[],
  artifactFlows: ArtifactFlow[],
  direction: LayoutDirection,
  autoAdvanceEdges?: AutoAdvanceEdge[],
  phases?: WorkflowPhase[],
  isStatic?: boolean,
  compactStaticPreview?: boolean,
  /** Snake only: phases per row; see {@link snakeColumnCount}. */
  snakeColumns?: number,
): LayoutResult {
  const effectivePhases = phases ?? defaultWorkflowPhases
  if (direction === 'snake') {
    return computeSnakeLayout(
      sessions,
      artifactFlows,
      autoAdvanceEdges,
      effectivePhases,
      snakeColumns ?? snakeColumnCount(effectivePhases.length, 0, 0),
      isStatic,
      compactStaticPreview,
    )
  }
  if (direction === 'TB') {
    return computePhaseRowLayout(
      sessions,
      artifactFlows,
      autoAdvanceEdges,
      effectivePhases,
      isStatic,
      compactStaticPreview,
    )
  }
  // Default: LR
  return computePhaseColumnLayout(
    sessions,
    artifactFlows,
    autoAdvanceEdges,
    effectivePhases,
    isStatic,
    compactStaticPreview,
  )
}

/**
 * LR layout: each phase is a column, sessions stack vertically within the column.
 *
 *                        [research]
 * [research-questions] → [research] → [design] → [outline] → [plan] → [impl] → [pr]
 *                        [research]                                     [impl]
 */
function computePhaseColumnLayout(
  sessions: WorkflowSession[],
  artifactFlows: ArtifactFlow[],
  autoAdvanceEdges?: AutoAdvanceEdge[],
  phases?: WorkflowPhase[],
  isStatic?: boolean,
  compactStaticPreview?: boolean,
): LayoutResult {
  const orderedPhases: WorkflowPhase[] = phases ?? defaultWorkflowPhases

  const sessionsByPhase = new Map<string, WorkflowSession[]>()
  for (const s of sessions) {
    const arr = sessionsByPhase.get(s.labelName) ?? []
    arr.push(s)
    sessionsByPhase.set(s.labelName, arr)
  }

  // Show all phases (full pipeline)
  const visiblePhases = orderedPhases

  // Compute the max session count across all phases to determine total height
  const maxSessionsInPhase = Math.max(
    1,
    ...visiblePhases.map((p) => (sessionsByPhase.get(p.name) ?? []).length),
  )
	const totalStackHeight =
		maxSessionsInPhase * SESSION_NODE_HEIGHT + (maxSessionsInPhase - 1) * SESSION_STACK_GAP
  const centerY = MARGIN + totalStackHeight / 2

  // Build nodes
  const nodes: WorkflowGraphNode[] = []
  const allNodeIds = new Set<string>()
  const placeholderWidth = compactStaticPreview
    ? COMPACT_STATIC_PLACEHOLDER_NODE_WIDTH
    : isStatic
      ? STATIC_PLACEHOLDER_NODE_WIDTH
      : PLACEHOLDER_NODE_WIDTH
  const placeholderHeight = compactStaticPreview
    ? COMPACT_STATIC_PLACEHOLDER_NODE_HEIGHT
    : isStatic
      ? STATIC_PLACEHOLDER_NODE_HEIGHT
      : PLACEHOLDER_NODE_HEIGHT
  const phaseStep = compactStaticPreview
    ? COMPACT_STATIC_PLACEHOLDER_NODE_WIDTH + 20
    : getPhaseStep(visiblePhases.length, isStatic, SESSION_NODE_WIDTH, PHASE_GAP_LR, STATIC_PREVIEW_WIDTH)

  for (const [colIdx, phase] of visiblePhases.entries()) {
    const phaseSessions = sessionsByPhase.get(phase.name) ?? []
    const x = MARGIN + colIdx * phaseStep

    if (phaseSessions.length === 0) {
      // Placeholder node, centered vertically
      const id = `placeholder-${phase.title}`
      nodes.push({
        id,
        type: 'phasePlaceholder',
        position: {
          x: x + (SESSION_NODE_WIDTH - placeholderWidth) / 2,
          y: centerY - placeholderHeight / 2,
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        data: {
          kind: 'phase',
          labelName: phase.name,
          labelTitle: phase.title,
          isStatic,
          compactStaticPreview,
          synthetic: phase.synthetic,
        },
      })
      allNodeIds.add(id)
    } else {
      // Stack sessions vertically, centered around centerY
		const stackHeight =
			phaseSessions.length * SESSION_NODE_HEIGHT + (phaseSessions.length - 1) * SESSION_STACK_GAP
      const startY = centerY - stackHeight / 2

      for (const [i, session] of phaseSessions.entries()) {
        nodes.push({
          id: session.id,
          type: 'session',
          position: {
            x,
				y: startY + i * (SESSION_NODE_HEIGHT + SESSION_STACK_GAP),
          },
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          data: { kind: 'session', session, synthetic: phase.synthetic },
        })
        allNodeIds.add(session.id)
      }
    }
  }

  const edges = buildEdges(visiblePhases, sessionsByPhase, artifactFlows, autoAdvanceEdges, allNodeIds, nodes, 'LR', centerY, isStatic)

  return { nodes, edges }
}

/** Card size for a phase with no session yet. */
function placeholderSize(isStatic?: boolean, compactStaticPreview?: boolean): { width: number; height: number } {
  if (compactStaticPreview) {
    return { width: COMPACT_STATIC_PLACEHOLDER_NODE_WIDTH, height: COMPACT_STATIC_PLACEHOLDER_NODE_HEIGHT }
  }
  if (isStatic) return { width: STATIC_PLACEHOLDER_NODE_WIDTH, height: STATIC_PLACEHOLDER_NODE_HEIGHT }
  return { width: PLACEHOLDER_NODE_WIDTH, height: PLACEHOLDER_NODE_HEIGHT }
}

const stackHeight = (count: number) => count * SESSION_NODE_HEIGHT + (count - 1) * SESSION_STACK_GAP

/** A snake grid cell: as wide as the widest card, as tall as the tallest stack of sessions in a phase. */
export function snakeCellSize(
  sessions: WorkflowSession[],
  phases: WorkflowPhase[],
  isStatic?: boolean,
  compactStaticPreview?: boolean,
): { width: number; height: number } {
  const counts = new Map<string, number>()
  for (const s of sessions) counts.set(s.labelName, (counts.get(s.labelName) ?? 0) + 1)
  const placeholder = placeholderSize(isStatic, compactStaticPreview)
  return {
    width: Math.max(SESSION_NODE_WIDTH, placeholder.width),
    height: Math.max(
      SESSION_NODE_HEIGHT,
      placeholder.height,
      ...phases.map((phase) => stackHeight(counts.get(phase.name) ?? 0)),
    ),
  }
}

/**
 * Phases per snake row for a pane of `width` × `height` and grid cells of `cell`: the count that
 * shows the cards largest once the whole grid is fitted. Without a measured pane, a square-ish grid.
 */
export function snakeColumnCount(
  phaseCount: number,
  width: number,
  height: number,
  cell: { width: number; height: number } = { width: SESSION_NODE_WIDTH, height: SESSION_NODE_HEIGHT },
): number {
  if (phaseCount <= 1) return 1
  if (width <= 0 || height <= 0) return Math.ceil(Math.sqrt(phaseCount))
  let best = 1
  let bestScale = 0
  for (let columns = 1; columns <= phaseCount; columns++) {
    const rows = Math.ceil(phaseCount / columns)
    const gridWidth = 2 * MARGIN + columns * cell.width + (columns - 1) * SNAKE_GAP_X
    const gridHeight = 2 * MARGIN + rows * cell.height + (rows - 1) * SNAKE_GAP_Y
    const scale = Math.min(width / gridWidth, height / gridHeight)
    // Ties keep the fewer columns.
    if (scale > bestScale + 1e-9) {
      best = columns
      bestScale = scale
    }
  }
  return best
}

/**
 * Snake layout: phases fill an evenly spaced grid row by row, alternating direction, so a long
 * workflow reads as one path in a compact pane. Each row turn drops straight down a column.
 *
 * [questions] → [research] → [design]
 *                                 ↓
 *   [plan]    ←  [outline]  ←  [...]
 *      ↓
 *   [impl]    →    [pr]
 *
 * Every cell has the size {@link snakeCellSize} gives, the same one the column count was picked for.
 */
function computeSnakeLayout(
  sessions: WorkflowSession[],
  artifactFlows: ArtifactFlow[],
  autoAdvanceEdges: AutoAdvanceEdge[] | undefined,
  phases: WorkflowPhase[],
  columns: number,
  isStatic?: boolean,
  compactStaticPreview?: boolean,
): LayoutResult {
  const sessionsByPhase = new Map<string, WorkflowSession[]>()
  for (const s of sessions) {
    const arr = sessionsByPhase.get(s.labelName) ?? []
    arr.push(s)
    sessionsByPhase.set(s.labelName, arr)
  }
  const perRow = Math.max(1, Math.min(columns, phases.length))
  const { width: cellWidth, height: cellHeight } = snakeCellSize(sessions, phases, isStatic, compactStaticPreview)
  const { width: placeholderWidth, height: placeholderHeight } = placeholderSize(isStatic, compactStaticPreview)

  const nodes: WorkflowGraphNode[] = []
  const allNodeIds = new Set<string>()
  // Where each session sits on the path, for routing artifact edges below.
  const sessionSlots = new Map<string, { index: number; row: number }>()
  for (const [index, phase] of phases.entries()) {
    const row = Math.floor(index / perRow)
    const inRow = index % perRow
    const forward = row % 2 === 0
    const column = forward ? inRow : perRow - 1 - inRow
    const x = MARGIN + column * (cellWidth + SNAKE_GAP_X)
    const y = MARGIN + row * (cellHeight + SNAKE_GAP_Y)
    const along = forward ? Position.Right : Position.Left
    const against = forward ? Position.Left : Position.Right
    // The path enters a row's first cell from above and leaves its last cell downward. In a stack
    // there, only the outer card (the last one leaving, the first one entering) takes the vertical
    // side; the others use the row's outer side, so their edges do not cross the rest of the stack.
    const turnIn = inRow === 0 && index > 0
    const turnOut = (inRow === perRow - 1 || index === phases.length - 1) && index < phases.length - 1
    const handles = (i: number, count: number) => ({
      sourcePosition: turnOut && i === count - 1 ? Position.Bottom : along,
      targetPosition: turnIn && i === 0 ? Position.Top : against,
    })

    const phaseSessions = sessionsByPhase.get(phase.name) ?? []
    if (phaseSessions.length === 0) {
      const id = `placeholder-${phase.title}`
      nodes.push({
        id,
        type: 'phasePlaceholder',
        position: {
          x: x + (cellWidth - placeholderWidth) / 2,
          y: y + (cellHeight - placeholderHeight) / 2,
        },
        ...handles(0, 1),
        data: {
          kind: 'phase',
          labelName: phase.name,
          labelTitle: phase.title,
          isStatic,
          compactStaticPreview,
          synthetic: phase.synthetic,
        },
      })
      allNodeIds.add(id)
      continue
    }
    const startY = y + (cellHeight - stackHeight(phaseSessions.length)) / 2
    for (const [i, session] of phaseSessions.entries()) {
      nodes.push({
        id: session.id,
        type: 'session',
        position: {
          x: x + (cellWidth - SESSION_NODE_WIDTH) / 2,
          y: startY + i * (SESSION_NODE_HEIGHT + SESSION_STACK_GAP),
        },
        ...handles(i, phaseSessions.length),
        data: { kind: 'session', session, synthetic: phase.synthetic },
      })
      allNodeIds.add(session.id)
      sessionSlots.set(session.id, { index, row })
    }
  }

  const edges = buildEdges(phases, sessionsByPhase, artifactFlows, autoAdvanceEdges, allNodeIds, nodes, 'snake', 0, isStatic)
  // An artifact flow between cards that are not next to each other on the path goes around the
  // cards between them: above the row when both ends share it, else past the grid's right edge.
  const gridRight = MARGIN + perRow * cellWidth + (perRow - 1) * SNAKE_GAP_X
  const centers = new Map(
    nodes.map((node) => [
      node.id,
      { x: node.position.x + SESSION_NODE_WIDTH / 2, y: node.position.y + SESSION_NODE_HEIGHT / 2 },
    ]),
  )
  let stagger = 0
  for (const edge of edges) {
    if (edge.type !== 'artifact' || !edge.data) continue
    const from = sessionSlots.get(edge.source)
    const to = sessionSlots.get(edge.target)
    const source = centers.get(edge.source)
    const target = centers.get(edge.target)
    if (!from || !to || !source || !target || Math.abs(from.index - to.index) <= 1) continue
    const offset = ROUTE_MARGIN + stagger * ROUTE_STAGGER
    stagger += 1
    // ArtifactEdge puts the label at the detour's turn: mid-way along, on the detour line.
    let label: { x: number; y: number }
    if (from.row === to.row) {
      const routeY = MARGIN + from.row * (cellHeight + SNAKE_GAP_Y) - offset
      edge.data = { ...edge.data, routeY }
      label = { x: (source.x + target.x) / 2, y: routeY }
    } else {
      const routeX = gridRight + offset
      edge.data = { ...edge.data, routeX }
      label = { x: routeX, y: (source.y + target.y) / 2 }
    }
    // The label can lie outside the cards: an invisible node over it makes every fit of the view
    // (the first one, after a remount, the fit button, after a drag) include it.
    const width = labelWidth(String(edge.data.fileName ?? ''))
    nodes.push({
      id: `extent-${edge.id}`,
      type: 'extent',
      position: { x: label.x - width / 2, y: label.y - LABEL_HEIGHT / 2 },
      width,
      height: LABEL_HEIGHT,
      draggable: false,
      selectable: false,
      focusable: false,
      data: { kind: 'extent', width, height: LABEL_HEIGHT, synthetic: true },
    })
  }
  return { nodes, edges }
}

function getPhaseStep(
  phaseCount: number,
  isStatic: boolean | undefined,
  nodeSize: number,
  phaseGap: number,
  staticPreviewSize: number,
): number {
  const defaultStep = nodeSize + phaseGap
  if (!isStatic || phaseCount <= 1) return defaultStep

  const spreadStep = (staticPreviewSize - nodeSize) / (phaseCount - 1)
  return Math.max(defaultStep, spreadStep)
}

/**
 * TB layout: each phase is a row, sessions spread horizontally within the row.
 *
 *              [research-questions]
 *                      |
 *       [research] [research] [research]
 *                      |
 *                  [design]
 *                      |
 *                  [outline]
 *                      |
 *                   [plan]
 *                      |
 *       [impl] [impl] [impl] [impl]
 *                      |
 *                    [pr]
 */
function computePhaseRowLayout(
  sessions: WorkflowSession[],
  artifactFlows: ArtifactFlow[],
  autoAdvanceEdges?: AutoAdvanceEdge[],
  phases?: WorkflowPhase[],
  isStatic?: boolean,
  compactStaticPreview?: boolean,
): LayoutResult {
  const orderedPhases: WorkflowPhase[] = phases ?? defaultWorkflowPhases

  const sessionsByPhase = new Map<string, WorkflowSession[]>()
  for (const s of sessions) {
    const arr = sessionsByPhase.get(s.labelName) ?? []
    arr.push(s)
    sessionsByPhase.set(s.labelName, arr)
  }

  // Show all phases (full pipeline)
  const visiblePhases = orderedPhases

  // Compute the max session count across all phases to determine total width
  const maxSessionsInPhase = Math.max(
    1,
    ...visiblePhases.map((p) => (sessionsByPhase.get(p.name) ?? []).length),
  )
	const totalSpreadWidth =
		maxSessionsInPhase * SESSION_NODE_WIDTH + (maxSessionsInPhase - 1) * SESSION_SPREAD_GAP
  const centerX = MARGIN + totalSpreadWidth / 2

  // Build nodes
  const nodes: WorkflowGraphNode[] = []
  const allNodeIds = new Set<string>()
  const placeholderWidth = compactStaticPreview
    ? COMPACT_STATIC_PLACEHOLDER_NODE_WIDTH
    : isStatic
      ? STATIC_PLACEHOLDER_NODE_WIDTH
      : PLACEHOLDER_NODE_WIDTH
  const placeholderHeight = compactStaticPreview
    ? COMPACT_STATIC_PLACEHOLDER_NODE_HEIGHT
    : isStatic
      ? STATIC_PLACEHOLDER_NODE_HEIGHT
      : PLACEHOLDER_NODE_HEIGHT
  const phaseStep = compactStaticPreview
    ? COMPACT_STATIC_PLACEHOLDER_NODE_HEIGHT + 20
    : getPhaseStep(visiblePhases.length, isStatic, SESSION_NODE_HEIGHT, PHASE_GAP_TB, STATIC_PREVIEW_HEIGHT)

  for (const [rowIdx, phase] of visiblePhases.entries()) {
    const phaseSessions = sessionsByPhase.get(phase.name) ?? []
    const y = MARGIN + rowIdx * phaseStep

    if (phaseSessions.length === 0) {
      const id = `placeholder-${phase.title}`
      nodes.push({
        id,
        type: 'phasePlaceholder',
        position: {
          x: centerX - placeholderWidth / 2,
          y: y + (SESSION_NODE_HEIGHT - placeholderHeight) / 2,
        },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        data: {
          kind: 'phase',
          labelName: phase.name,
          labelTitle: phase.title,
          isStatic,
          compactStaticPreview,
          synthetic: phase.synthetic,
        },
      })
      allNodeIds.add(id)
    } else {
      // Spread sessions horizontally, centered around centerX
		const spreadWidth =
			phaseSessions.length * SESSION_NODE_WIDTH + (phaseSessions.length - 1) * SESSION_SPREAD_GAP
      const startX = centerX - spreadWidth / 2

      for (const [i, session] of phaseSessions.entries()) {
        nodes.push({
          id: session.id,
          type: 'session',
          position: {
				x: startX + i * (SESSION_NODE_WIDTH + SESSION_SPREAD_GAP),
            y,
          },
          sourcePosition: Position.Bottom,
          targetPosition: Position.Top,
          data: { kind: 'session', session, synthetic: phase.synthetic },
        })
        allNodeIds.add(session.id)
      }
    }
  }

  const edges = buildEdges(visiblePhases, sessionsByPhase, artifactFlows, autoAdvanceEdges, allNodeIds, nodes, 'TB', centerX, isStatic)

  return { nodes, edges }
}

/**
 * Build edges shared by both layout modes:
 * 1. Structural edges ONLY between consecutive placeholder (un-started) phases
 * 2. Artifact flow edges between sessions (data-driven)
 */
function buildEdges(
  visiblePhases: Array<{ name: string; title: string }>,
  sessionsByPhase: Map<string, WorkflowSession[]>,
  artifactFlows: ArtifactFlow[],
  autoAdvanceEdges: AutoAdvanceEdge[] | undefined,
  allNodeIds: Set<string>,
  nodes: WorkflowGraphNode[],
  direction: LayoutDirection,
  layoutCenter: number,
  isStatic?: boolean,
): Edge[] {
  const edges: Edge[] = []

  const autoAdvanceSet = new Set(
    (autoAdvanceEdges ?? []).map((e) => `${e.fromLabel}->${e.toLabel}`),
  )

  // Structural edges between consecutive phases.
  // In static mode: always draw edges between all phases.
  // When no artifact flows are provided: always draw structural edges (show workflow direction).
  // Otherwise: only draw when target is a placeholder (artifact flows show real connections).
  const hasArtifactFlows = artifactFlows.length > 0
  for (let i = 0; i < visiblePhases.length - 1; i++) {
    const sourcePhase = visiblePhases[i]
    const targetPhase = visiblePhases[i + 1]
    if (sourcePhase === undefined || targetPhase === undefined) continue
    const sourceSessions = sessionsByPhase.get(sourcePhase.name) ?? []
    const targetSessions = sessionsByPhase.get(targetPhase.name) ?? []

    if (targetSessions.length > 0 && !isStatic && hasArtifactFlows) continue

    const lastSourceSession = sourceSessions.at(-1)
    const sourceId = lastSourceSession !== undefined
      ? lastSourceSession.id
      : `placeholder-${sourcePhase.title}`
    const firstTargetSession = targetSessions[0]
    const targetId = firstTargetSession !== undefined
      ? firstTargetSession.id
      : `placeholder-${targetPhase.title}`

    const isAutoAdvance =
      autoAdvanceSet.has(`${sourcePhase.name}->${targetPhase.name}`) &&
      targetSessions.length === 0

    edges.push({
      id: `structural-${sourceId}-${targetId}`,
      source: sourceId,
      target: targetId,
      type: isAutoAdvance ? 'autoAdvance' : 'default',
      style: isAutoAdvance ? undefined : {
        stroke: 'var(--terminal-fg)',
        strokeWidth: 1.5,
        strokeDasharray: targetSessions.length === 0 ? '4 3' : undefined,
        opacity: 0.5,
      },
      animated: false,
    })
  }

  // --- Routing for artifact edges that cross intermediate session nodes ---
  const phaseIdxByTitle = new Map<string, number>()
  for (const [i, phase] of visiblePhases.entries()) {
    phaseIdxByTitle.set(phase.title, i)
  }
  const sessionPhaseIdx = new Map<string, number>()
  for (const [title, sessions] of sessionsByPhase) {
    const idx = phaseIdxByTitle.get(title)
    if (idx !== undefined) {
      for (const s of sessions) sessionPhaseIdx.set(s.id, idx)
    }
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  let routeStaggerIdx = 0

  // Artifact flow edges between sessions (data-driven edges)
  for (const flow of artifactFlows) {
    if (!allNodeIds.has(flow.fromSessionId) || !allNodeIds.has(flow.toSessionId)) continue

    const fromIdx = sessionPhaseIdx.get(flow.fromSessionId)
    const toIdx = sessionPhaseIdx.get(flow.toSessionId)
    let routeData: Record<string, number> = {}

    if (fromIdx !== undefined && toIdx !== undefined && Math.abs(toIdx - fromIdx) > 1) {
      const minIdx = Math.min(fromIdx, toIdx)
      const maxIdx = Math.max(fromIdx, toIdx)

      const intermediatePositions: Array<{ x: number; y: number }> = []
      for (let p = minIdx + 1; p < maxIdx; p++) {
        const phase = visiblePhases[p]
        if (phase === undefined) continue
        const title = phase.title
        for (const s of (sessionsByPhase.get(title) ?? [])) {
          const node = nodeById.get(s.id)
          if (node) intermediatePositions.push(node.position)
        }
      }

      if (intermediatePositions.length > 0) {
        const sourceNode = nodeById.get(flow.fromSessionId)
        const targetNode = nodeById.get(flow.toSessionId)

        if (sourceNode && targetNode && direction === 'LR') {
          const srcHY = sourceNode.position.y + SESSION_NODE_HEIGHT / 2
          const tgtHY = targetNode.position.y + SESSION_NODE_HEIGHT / 2
          const corridorTop = Math.min(srcHY, tgtHY) - SESSION_NODE_HEIGHT
          const corridorBot = Math.max(srcHY, tgtHY) + SESSION_NODE_HEIGHT
          const blocking = intermediatePositions.filter(
            (p) => p.y < corridorBot && p.y + SESSION_NODE_HEIGHT > corridorTop,
          )
          if (blocking.length > 0) {
            const edgeMidY = (srcHY + tgtHY) / 2
            const routeBelow = edgeMidY > layoutCenter
            if (routeBelow) {
              const botY = Math.max(...blocking.map((p) => p.y + SESSION_NODE_HEIGHT))
              routeData = { routeY: botY + ROUTE_MARGIN + routeStaggerIdx * ROUTE_STAGGER }
            } else {
              const topY = Math.min(...blocking.map((p) => p.y))
              routeData = { routeY: topY - ROUTE_MARGIN - routeStaggerIdx * ROUTE_STAGGER }
            }
            routeStaggerIdx++
          }
        } else if (sourceNode && targetNode && direction === 'TB') {
          const srcHX = sourceNode.position.x + SESSION_NODE_WIDTH / 2
          const tgtHX = targetNode.position.x + SESSION_NODE_WIDTH / 2
          const corridorL = Math.min(srcHX, tgtHX) - SESSION_NODE_WIDTH
          const corridorR = Math.max(srcHX, tgtHX) + SESSION_NODE_WIDTH
          const blocking = intermediatePositions.filter(
            (p) => p.x < corridorR && p.x + SESSION_NODE_WIDTH > corridorL,
          )
          if (blocking.length > 0) {
            const edgeMidX = (srcHX + tgtHX) / 2
            const routeRight = edgeMidX > layoutCenter
            if (routeRight) {
              const rightX = Math.max(...blocking.map((p) => p.x + SESSION_NODE_WIDTH))
              routeData = { routeX: rightX + ROUTE_MARGIN + routeStaggerIdx * ROUTE_STAGGER }
            } else {
              const leftX = Math.min(...blocking.map((p) => p.x))
              routeData = { routeX: leftX - ROUTE_MARGIN - routeStaggerIdx * ROUTE_STAGGER }
            }
            routeStaggerIdx++
          }
        }
      }
    }

    edges.push({
      id: `artifact-${flow.fromSessionId}-${flow.toSessionId}-${flow.fileName}`,
      source: flow.fromSessionId,
      target: flow.toSessionId,
      type: 'artifact',
      data: {
        fileName: flow.fileName,
        category: flow.category,
        ...routeData,
      },
    })
  }

  return edges
}
