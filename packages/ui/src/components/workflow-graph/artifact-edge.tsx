import { BaseEdge, EdgeLabelRenderer, type Edge, type EdgeProps, getBezierPath } from '@xyflow/react'
import { type FC, useState } from 'react'
import { ARTIFACT_CATEGORY_COLORS } from './utils'

export interface ArtifactEdgeData extends Record<string, unknown> {
  fileName: string
  category: 'source' | 'edited' | 'new'
  onArtifactClick?: (fileName: string) => void
  onEdgeLabelHover?: () => void
  onEdgeLabelLeave?: () => void
  routeY?: number
  routeX?: number
}

type ArtifactGraphEdge = Edge<ArtifactEdgeData, 'artifact'>

/** How far a routeY detour steps out from a card before rising; under half the narrowest gap (32px). */
const ROUTE_STEP = 12

export const ArtifactEdge: FC<EdgeProps<ArtifactGraphEdge>> = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}) => {
  if (!data) return null
  const { fileName, category, onArtifactClick, onEdgeLabelHover, onEdgeLabelLeave, routeY, routeX } = data
  const color = ARTIFACT_CATEGORY_COLORS[category] ?? 'var(--terminal-fg)'
  const [isHovered, setIsHovered] = useState(false)

  let edgePath: string
  let labelX: number
  let labelY: number

  if (routeY !== undefined) {
    // Step out into the gap beside the source card, rise to routeY, run along it over the cards in
    // between, then drop into the target, so the curve never crosses an intermediate card. `step`
    // stays inside the gap between cards and points toward the target (a snake graph's
    // right-to-left rows run the other way).
    const midX = (sourceX + targetX) / 2
    const step = Math.min(ROUTE_STEP, Math.abs(targetX - sourceX) / 4) * (targetX >= sourceX ? 1 : -1)
    edgePath = [
      `M ${sourceX} ${sourceY}`,
      `C ${sourceX + step} ${sourceY}, ${sourceX + step} ${routeY}, ${sourceX + 2 * step} ${routeY}`,
      `L ${targetX - 2 * step} ${routeY}`,
      `C ${targetX - step} ${routeY}, ${targetX - step} ${targetY}, ${targetX} ${targetY}`,
    ].join(' ')
    labelX = midX
    labelY = routeY
  } else if (routeX !== undefined) {
    const midY = (sourceY + targetY) / 2
    const cpY = Math.abs(targetY - sourceY) * 0.25 * (targetY >= sourceY ? 1 : -1)
    edgePath = [
      `M ${sourceX} ${sourceY}`,
      `C ${sourceX} ${sourceY + cpY}, ${routeX} ${midY - cpY}, ${routeX} ${midY}`,
      `C ${routeX} ${midY + cpY}, ${targetX} ${targetY - cpY}, ${targetX} ${targetY}`,
    ].join(' ')
    labelX = routeX
    labelY = midY
  } else {
    ;[edgePath, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
    })
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: color,
          strokeWidth: selected || isHovered ? 2 : 1.5,
          ...(selected || isHovered ? { opacity: 1 } : {}),
        }}
      />
      <EdgeLabelRenderer>
        <button
          type="button"
          className="nodrag nopan font-mono"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
            fontSize: '10px',
            padding: '2px 6px',
            borderRadius: '0',
            border: `1px solid color-mix(in srgb, ${color} 50%, transparent)`,
            backgroundColor: `color-mix(in srgb, ${color} 10%, var(--terminal-bg))`,
            color: color,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            ...(isHovered ? { opacity: 1 } : {}),
          }}
          onMouseEnter={() => {
            setIsHovered(true)
            onEdgeLabelHover?.()
          }}
          onMouseLeave={() => {
            setIsHovered(false)
            onEdgeLabelLeave?.()
          }}
          onClick={(e) => {
            e.stopPropagation()
            onArtifactClick?.(fileName)
          }}
        >
          {fileName}
        </button>
      </EdgeLabelRenderer>
    </>
  )
}

export type ArtifactEdgeProps = EdgeProps
