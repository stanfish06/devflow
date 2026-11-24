// Keep the default at 3: higher concurrency has caused Bun segfaults.
function serviceTestConcurrency(value: string | undefined): number {
	if (value === undefined) return 3
	if (!/^[1-6]$/.test(value)) {
		throw new Error('SERVICE_TEST_CONCURRENCY must be an integer from 1 to 6')
	}
	return Number(value)
}

const concurrency = serviceTestConcurrency(process.env.SERVICE_TEST_CONCURRENCY)
const servicesStarted = performance.now()
const child = Bun.spawn(
	[
		'bun',
		'--env-file=.env',
		'turbo',
		'run',
		'test',
		'--filter=@devflow/api',
		'--filter=@devflow/test-fixtures',
		'--filter=@devflow/sync-proxy',
		'--filter=@devflow/session-sweeper',
		`--concurrency=${concurrency}`,
	],
	{
		stdout: 'inherit',
		stderr: 'inherit',
	},
)

const exitCode = await child.exited
console.log(
	`[test-services] package tests (concurrency=${concurrency}): ${((performance.now() - servicesStarted) / 1000).toFixed(1)}s (exit ${exitCode})`,
)
if (exitCode !== 0) process.exit(exitCode)

const daemonStarted = performance.now()
const daemonDatabaseTests = Bun.spawn(
	[
		'bun',
		'--env-file=.env',
		'vitest',
		'run',
		'--config',
		'apps/agent-runner/vitest.config.ts',
		'--project',
		'database',
	],
	{
		stdout: 'inherit',
		stderr: 'inherit',
	},
)

const daemonExitCode = await daemonDatabaseTests.exited
console.log(
	`[test-services] daemon database tests: ${((performance.now() - daemonStarted) / 1000).toFixed(1)}s (exit ${daemonExitCode})`,
)
process.exit(daemonExitCode)
