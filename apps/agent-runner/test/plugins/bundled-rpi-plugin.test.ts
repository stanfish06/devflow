import { accessSync, constants, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { embeddedFiles, PLUGIN_VERSION } from '@/plugins/bundled-rpi-plugin'
import { ensureRpiPluginOnDisk, getRpiPluginPath } from '@/plugins/ensure-plugin'

import { withEnv } from '../helpers/concurrency'

describe('bundled-rpi-plugin', () => {
	describe('embeddedFiles', () => {
		it('should have plugin.json in manifest', () => {
			expect(embeddedFiles['.claude-plugin/plugin.json']).toBeDefined()
		})

		it('should have all expected skills', () => {
			const expectedSkills = [
				'create-plan',
				'iterate-plan',
				'create-research',
				'iterate-research',
				'create-research-questions',
				'iterate-research-questions',
				'create-design-discussion',
				'iterate-design-discussion',
				'create-structure-outline',
				'iterate-structure-outline',
				'implement-plan',
				'setup-worktree',
				'ci-commit',
				'describe-pr',
			]

			for (const skill of expectedSkills) {
				const skillPath = `skills/${skill}/SKILL.md`
				expect(skillPath in embeddedFiles).toBe(true)
			}
		})

		it('should have valid embedded paths that can be read', async () => {
			// Test reading the plugin.json as a sample
			const pluginJsonPath = embeddedFiles['.claude-plugin/plugin.json']
			expect(pluginJsonPath).toBeDefined()
			const content = await readFile(pluginJsonPath!, 'utf-8')
			const parsed = JSON.parse(content)

			expect(parsed.name).toBe('rpi')
			expect(parsed.version).toBe(PLUGIN_VERSION)
		})

		it('should include resolved design discussion final answer templates', () => {
			expect(
				embeddedFiles['skills/create-design-discussion/references/design_discussion_final_answer_resolved.md'],
			).toBeDefined()
			expect(
				embeddedFiles['skills/iterate-design-discussion/references/design_discussion_final_answer_resolved.md'],
			).toBeDefined()
		})

		it('should include create-design-discussion visual guidance', () => {
			expect(embeddedFiles['skills/create-design-discussion/references/show-me.md']).toBeDefined()
		})

		it('should include describe-pr walkthrough diff script', () => {
			expect(embeddedFiles['skills/describe-pr/scripts/inject-walkthrough-diffs.sh']).toBeDefined()
		})
	})

	describe('ensureRpiPluginOnDisk', () => {
		// Use temp directory to avoid polluting user's home directory
		let tempBaseDir: string
		let savedEnvVars: { DEVFLOW_RPI_PLUGIN_PATH?: string; DEVFLOW_DAEMON_FORCE_LOCAL_PLUGIN?: string }

		beforeAll(() => {
			tempBaseDir = mkdtempSync(join(tmpdir(), 'rpi-plugin-test-'))
		})

		afterAll(() => {
			// Clean up temp directory after tests
			if (tempBaseDir && existsSync(tempBaseDir)) {
				rmSync(tempBaseDir, { recursive: true, force: true })
			}
		})

		beforeEach(() => {
			// Save and clear dev mode env vars to test bundled plugin behavior
			savedEnvVars = {
				DEVFLOW_RPI_PLUGIN_PATH: process.env.DEVFLOW_RPI_PLUGIN_PATH,
				DEVFLOW_DAEMON_FORCE_LOCAL_PLUGIN: process.env.DEVFLOW_DAEMON_FORCE_LOCAL_PLUGIN,
			}
			delete process.env.DEVFLOW_RPI_PLUGIN_PATH
			delete process.env.DEVFLOW_DAEMON_FORCE_LOCAL_PLUGIN
		})

		afterEach(() => {
			// Restore env vars
			if (savedEnvVars.DEVFLOW_RPI_PLUGIN_PATH !== undefined) {
				process.env.DEVFLOW_RPI_PLUGIN_PATH = savedEnvVars.DEVFLOW_RPI_PLUGIN_PATH
			}
			if (savedEnvVars.DEVFLOW_DAEMON_FORCE_LOCAL_PLUGIN !== undefined) {
				process.env.DEVFLOW_DAEMON_FORCE_LOCAL_PLUGIN = savedEnvVars.DEVFLOW_DAEMON_FORCE_LOCAL_PLUGIN
			}
		})

		it('should write plugin to disk and return path', async () => {
			const expectedPath = getRpiPluginPath(tempBaseDir)
			const pluginPath = await withEnv(
				{
					DEVFLOW_RPI_PLUGIN_PATH: undefined,
					DEVFLOW_DAEMON_FORCE_LOCAL_PLUGIN: undefined,
				},
				() => ensureRpiPluginOnDisk(tempBaseDir),
			)

			expect(pluginPath).toBe(expectedPath)
			expect(existsSync(pluginPath)).toBe(true)
		})

		it('should create correct directory structure', async () => {
			const pluginPath = await withEnv(
				{
					DEVFLOW_RPI_PLUGIN_PATH: undefined,
					DEVFLOW_DAEMON_FORCE_LOCAL_PLUGIN: undefined,
				},
				() => ensureRpiPluginOnDisk(tempBaseDir),
			)

			// Check plugin.json exists
			const pluginJsonPath = join(pluginPath, '.claude-plugin', 'plugin.json')
			expect(existsSync(pluginJsonPath)).toBe(true)

			// Check a sample skill exists
			const skillPath = join(pluginPath, 'skills', 'create-plan', 'SKILL.md')
			expect(existsSync(skillPath)).toBe(true)

			// Check a reference file exists
			const refPath = join(pluginPath, 'skills', 'create-plan', 'references', 'plan_template.md')
			expect(existsSync(refPath)).toBe(true)

			const describePrScriptPath = join(
				pluginPath,
				'skills',
				'describe-pr',
				'scripts',
				'inject-walkthrough-diffs.sh',
			)
			expect(existsSync(describePrScriptPath)).toBe(true)
			expect(() => accessSync(describePrScriptPath, constants.X_OK)).not.toThrow()
		})

		it('should write correct file contents', async () => {
			const pluginPath = await withEnv(
				{
					DEVFLOW_RPI_PLUGIN_PATH: undefined,
					DEVFLOW_DAEMON_FORCE_LOCAL_PLUGIN: undefined,
				},
				() => ensureRpiPluginOnDisk(tempBaseDir),
			)

			// Read and verify plugin.json
			const pluginJsonPath = join(pluginPath, '.claude-plugin', 'plugin.json')
			const pluginJson = JSON.parse(await readFile(pluginJsonPath, 'utf-8'))

			expect(pluginJson.name).toBe('rpi')
			expect(pluginJson.version).toBe(PLUGIN_VERSION)
		})

		it('should be idempotent - return immediately if already exists', async () => {
			// First call creates the directory
			const firstPath = await withEnv(
				{
					DEVFLOW_RPI_PLUGIN_PATH: undefined,
					DEVFLOW_DAEMON_FORCE_LOCAL_PLUGIN: undefined,
				},
				() => ensureRpiPluginOnDisk(tempBaseDir),
			)

			// Second call should return same path without error
			const secondPath = await withEnv(
				{
					DEVFLOW_RPI_PLUGIN_PATH: undefined,
					DEVFLOW_DAEMON_FORCE_LOCAL_PLUGIN: undefined,
				},
				() => ensureRpiPluginOnDisk(tempBaseDir),
			)

			expect(secondPath).toBe(firstPath)
			expect(existsSync(secondPath)).toBe(true)
		})

		it('should write all expected files', async () => {
			const pluginPath = await withEnv(
				{
					DEVFLOW_RPI_PLUGIN_PATH: undefined,
					DEVFLOW_DAEMON_FORCE_LOCAL_PLUGIN: undefined,
				},
				() => ensureRpiPluginOnDisk(tempBaseDir),
			)

			// Verify all files from manifest exist
			for (const relativePath of Object.keys(embeddedFiles)) {
				const fullPath = join(pluginPath, relativePath)
				expect(existsSync(fullPath)).toBe(true)
			}
		})
	})

	describe('PLUGIN_VERSION', () => {
		it('should match the embedded plugin.json version', async () => {
			const pluginJsonPath = embeddedFiles['.claude-plugin/plugin.json']
			expect(pluginJsonPath).toBeDefined()
			const content = await readFile(pluginJsonPath!, 'utf-8')
			const parsed = JSON.parse(content)

			expect(PLUGIN_VERSION).toBe(parsed.version)
		})
	})
})
