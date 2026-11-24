import { base } from '@devflow/vitest-config'
import { defineConfig, mergeConfig } from 'vitest/config'

export default mergeConfig(base, defineConfig({}))
