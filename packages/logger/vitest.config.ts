import { base } from '@devflow/vitest-config'
import { defineConfig, mergeConfig } from 'vitest/config'

// Run test files one at a time: they replace the global `console` and measure memory usage.
export default mergeConfig(base, defineConfig({ test: { fileParallelism: false } }))
