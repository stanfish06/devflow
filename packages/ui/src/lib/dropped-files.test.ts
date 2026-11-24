import { describe, expect, test } from 'vitest'

import { dragCarriesFiles, readDroppedFiles } from './dropped-files'

function dataTransfer(input: { types: string[]; files?: File[] }): DataTransfer {
	return { types: input.types, files: input.files ?? [] } as unknown as DataTransfer
}

describe('dropped files', () => {
	test('recognizes a drag that carries files', () => {
		expect(dragCarriesFiles(dataTransfer({ types: ['Files'] }))).toBe(true)
		expect(dragCarriesFiles(dataTransfer({ types: ['text/plain'] }))).toBe(false)
		expect(dragCarriesFiles(null)).toBe(false)
	})

	test('returns the dropped files', async () => {
		const file = new File(['hi'], 'note.md')
		await expect(readDroppedFiles(dataTransfer({ types: ['Files'], files: [file] }))).resolves.toEqual([file])
	})
})
