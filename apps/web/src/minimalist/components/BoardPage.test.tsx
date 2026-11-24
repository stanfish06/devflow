import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { StageId } from '@/lib/kanban/columnEngine'

import { StageTag } from './BoardPage'

const LABELS: Record<StageId, string> = {
	'research-design': 'Research & Design',
	planning: 'Planning',
	implementation: 'Implementation',
	'in-review': 'In Review',
}

describe('StageTag', () => {
	it.each(Object.entries(LABELS) as Array<[StageId, string]>)(
		'renders %s as one tagged pill titled %s',
		(stage, label) => {
			const { container } = render(<StageTag stage={stage} />)
			const tags = container.querySelectorAll('[data-stage]')
			expect(tags).toHaveLength(1)
			expect(tags[0]?.getAttribute('data-stage')).toBe(stage)
			expect(tags[0]?.textContent).toBe(label)
		},
	)

	it('renders nothing when the task has no stage', () => {
		const { container } = render(<StageTag stage={null} />)
		expect(container.innerHTML).toBe('')
	})
})
