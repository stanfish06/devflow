import { defineConfig } from '@playwright/test'

// End-to-end tests against a running devflow stack (`bun run devflow up`), in the installed Chrome.
// Tests share one stack and one project, so they run one at a time.
export default defineConfig({
	testDir: './tests',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	// Real agent turns (Haiku) take 10-90s each; the RPI test waits for two of them.
	timeout: 8 * 60_000,
	expect: { timeout: 120_000 },
	reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
	use: {
		baseURL: process.env.DEVFLOW_APP_URL ?? 'https://app.devflow.localhost:47443',
		channel: 'chrome',
		headless: process.env.HEADED !== '1',
		viewport: { width: 1512, height: 900 },
		screenshot: 'on',
		trace: 'retain-on-failure',
	},
	outputDir: 'test-results',
})
