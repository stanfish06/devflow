import { Position } from '@xyflow/react'
import { describe, expect, it } from 'vitest'

import { computeLayout, snakeColumnCount } from './layout-lite'
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

  it('falls back to a square-ish grid before the pane is measured', () => {
    expect(snakeColumnCount(7, 0, 0)).toBe(3)
    expect(snakeColumnCount(1, 0, 0)).toBe(1)
  })
})

describe('computeLayout snake', () => {
  const sessions = [session('q', 'questions'), session('r', 'research'), session('d', 'design')]
  const { nodes, edges } = computeLayout(sessions, [], 'snake', undefined, phases, false, false, 3)
  const byPhase = (title: string) =>
    nodes.find((node) =>
      node.data.kind === 'session' ? node.data.session.labelTitle === title : node.data.labelTitle === title,
    )
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
})
