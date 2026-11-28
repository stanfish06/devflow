import { Position } from '@xyflow/react'
import { describe, expect, it } from 'vitest'

import { computeLayout, snakeCellSize, snakeColumnCount } from './layout-lite'
import type { WorkflowPhase, WorkflowSession } from './types-lite'

const phases: WorkflowPhase[] = ['questions', 'research', 'design', 'outline', 'plan', 'implement', 'pr'].map(
  (title) => ({ name: `rpi:${title}`, title }) as WorkflowPhase,
)

const session = (id: string, title: string): WorkflowSession => ({
  id,
  status: 'ready_for_input',
  labelName: `rpi:${title}`,
  labelTitle: title,
  artifacts: [],
})

describe('snakeColumnCount', () => {
  it('picks the column count that shows the cards largest in the pane', () => {
    // The task panel: narrow and tall.
    expect(snakeColumnCount(7, 220, 300)).toBe(2)
    // A wide dialog.
    expect(snakeColumnCount(7, 1600, 500)).toBe(4)
  })

  it('sizes the grid by its real cells, so a tall session stack can call for more columns', () => {
    const stacked = [session('a', 'research'), session('b', 'research'), session('c', 'research')]
    const cell = snakeCellSize(stacked, phases)
    expect(cell.height).toBe(3 * 90 + 2 * 8)
    expect(snakeColumnCount(7, 600, 400, cell)).toBe(4)
    // With the 90px estimate the same pane would get 3 columns and smaller cards.
    expect(snakeColumnCount(7, 600, 400)).toBe(3)
  })

  it('falls back to a square-ish grid before the pane is measured', () => {
    expect(snakeColumnCount(7, 0, 0)).toBe(3)
    expect(snakeColumnCount(1, 0, 0)).toBe(1)
  })
})

describe('computeLayout snake', () => {
  const sessions = [session('q', 'questions'), session('r', 'research'), session('d', 'design')]
  const { nodes, edges } = computeLayout(sessions, [], 'snake', undefined, phases, false, false, 3)
  const titleOf = (node: (typeof nodes)[number]) => {
    if (node.data.kind === 'session') return node.data.session.labelTitle
    if (node.data.kind === 'phase') return node.data.labelTitle
    return null
  }
  const byPhase = (title: string) => nodes.find((node) => titleOf(node) === title)
  const cell = (title: string) => {
    const node = byPhase(title)
    return node ? { x: node.position.x, y: node.position.y } : undefined
  }

  it('fills rows left to right, then right to left, on an evenly spaced grid', () => {
    const [q, r, d] = [cell('questions'), cell('research'), cell('design')]
    expect(q?.y).toBe(r?.y)
    expect(r?.y).toBe(d?.y)
    expect((r?.x ?? 0) - (q?.x ?? 0)).toBe((d?.x ?? 0) - (r?.x ?? 0))
    // Row two runs back: outline sits under design, plan to its left.
    const outline = byPhase('outline')
    const plan = byPhase('plan')
    expect(outline && plan && outline.position.x > plan.position.x).toBe(true)
    expect(outline && d && outline.position.y > d.y).toBe(true)
  })

  it('connects along each row and drops down at each turn', () => {
    expect(byPhase('questions')?.sourcePosition).toBe(Position.Right)
    expect(byPhase('design')?.sourcePosition).toBe(Position.Bottom)
    expect(byPhase('outline')?.targetPosition).toBe(Position.Top)
    expect(byPhase('outline')?.sourcePosition).toBe(Position.Left)
    expect(byPhase('plan')?.targetPosition).toBe(Position.Right)
    expect(byPhase('implement')?.sourcePosition).toBe(Position.Bottom)
    expect(byPhase('pr')?.targetPosition).toBe(Position.Top)
    // One structural edge per step of the path once the started phases end.
    expect(edges.filter((edge) => edge.id.startsWith('structural-'))).toHaveLength(6)
  })

  it('routes artifact flows that skip cards around them instead of through them', () => {
    const all = phases.map((phase, index) => session(`s${index}`, phase.title))
    const flow = (from: string, to: string) => ({ fromSessionId: from, toSessionId: to, fileName: `${from}-${to}.md`, category: 'source' as const })
    const routed = computeLayout(all, [flow('s0', 's1'), flow('s0', 's2'), flow('s0', 's5')], 'snake', undefined, phases, false, false, 3)
    const data = (to: string) => routed.edges.find((edge) => edge.target === to && edge.type === 'artifact')?.data
    const top = (id: string) => routed.nodes.find((node) => node.id === id)?.position.y ?? 0
    const cards = routed.nodes.filter((node) => node.type === 'session')
    const right = Math.max(...cards.map((node) => node.position.x)) + 170
    // Next on the path: a direct curve.
    expect(data('s1')?.routeY).toBeUndefined()
    expect(data('s1')?.routeX).toBeUndefined()
    // Same row, skipping s1: above the row.
    expect(Number(data('s2')?.routeY)).toBeLessThan(top('s0'))
    // Another row: past the grid's right edge.
    expect(Number(data('s5')?.routeX)).toBeGreaterThan(right)
    // Each detour label gets an invisible node, so fitting the view includes it.
    const extents = routed.nodes.filter((node) => node.type === 'extent')
    expect(extents).toHaveLength(2)
    expect(extents.some((node) => node.position.y < Number(data('s2')?.routeY))).toBe(true)
    expect(extents.some((node) => node.position.x + Number(node.width) > Number(data('s5')?.routeX))).toBe(true)
    expect(extents.every((node) => node.draggable === false && node.selectable === false)).toBe(true)
  })

  it('adds nothing to fit for an empty workflow', () => {
    expect(computeLayout([], [], 'snake', undefined, [], false, false, 3)).toEqual({ nodes: [], edges: [] })
  })

  it('gives only the outer card of a stack at a row turn the vertical side', () => {
    const stacked = [session('d1', 'design'), session('d2', 'design'), session('o1', 'outline'), session('o2', 'outline')]
    const turn = computeLayout(stacked, [], 'snake', undefined, phases, false, false, 3)
    const node = (id: string) => turn.nodes.find((n) => n.id === id)
    // design ends row one (left to right); outline starts row two (right to left).
    expect(node('d1')?.sourcePosition).toBe(Position.Right)
    expect(node('d2')?.sourcePosition).toBe(Position.Bottom)
    expect(node('o1')?.targetPosition).toBe(Position.Top)
    expect(node('o2')?.targetPosition).toBe(Position.Right)
  })
})
