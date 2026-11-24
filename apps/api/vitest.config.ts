import { resolve } from 'node:path'

import { base } from '@devflow/vitest-config'
import { defineConfig, mergeConfig } from 'vitest/config'

const defaultDatabaseUrl = 'postgresql://postgres:test_password@127.0.0.1:55432/electric'

export default mergeConfig(
	base,
	defineConfig({
		test: {
			env: {
				DATABASE_URL: process.env.DATABASE_URL ?? defaultDatabaseUrl,
				READ_REPLICA_DATABASE_URL:
					process.env.READ_REPLICA_DATABASE_URL ?? process.env.DATABASE_URL ?? defaultDatabaseUrl,
				// app-runtime builds the live S3 service at module load via requireEnvironment(); this is a load-time placeholder.
				S3_ARTIFACTS_BUCKET: process.env.S3_ARTIFACTS_BUCKET ?? 'test-artifacts',
			},
			testTimeout: 15_000,
			// Default serial; the `unit` project opts into parallelism below. maxWorkers
			// only takes effect when fileParallelism is true (the unit project); when
			// fileParallelism is false Vitest forces maxWorkers to 1.
			fileParallelism: false,
			maxWorkers: 4,
			projects: [
				{
					extends: true,
					test: {
						name: 'unit',
						include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'test/effect/**/*.vi.test.ts'],
						setupFiles: ['test/utils/setup-unit.ts'],
						exclude: [
							'test/procedures/events-create-status-advance.test.ts',
							'test/procedures/tasks-create-title-generation.test.ts',
							'test/procedures/sessions-launch-title-generation.test.ts',
						],
						globalSetup: ['test/utils/global-setup.ts'],
						// Each unit test file provisions its own unique random Postgres
						// database (see test/utils/test-db.ts), so files are safe to run in
						// parallel. Bounded to 4 workers to keep connection/CREATE-DROP-DATABASE
						// pressure well under postgres max_connections (500).
						fileParallelism: true,
						isolate: false,
					},
				},
				{
					extends: true,
					test: {
						name: 'unit-isolated',
						include: [
							'test/procedures/events-create-status-advance.test.ts',
							// Its @devflow/ai vi.mock needs a fresh module registry; the
							// shared `unit` registry (isolate: false) applies mocks
							// order-dependently across files.
							'test/procedures/tasks-create-title-generation.test.ts',
							'test/procedures/sessions-launch-title-generation.test.ts',
						],
						globalSetup: ['test/utils/global-setup.ts'],
					},
				},
			],
		},
		resolve: {
			alias: {
				'@': resolve(import.meta.dirname, 'src'),
			},
		},
	}),
)
