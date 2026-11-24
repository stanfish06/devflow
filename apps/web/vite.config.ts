import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type PluginOption } from 'vite'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/+$/, '')
const env = { ...loadEnv(process.env.NODE_ENV ?? 'development', repoRoot, ''), ...process.env }

const plugins: PluginOption[] = [
	{
		// react-scan is a dev-server-only diagnostic; alias it to a no-op stub in every build so
		// production bundles skip its per-commit instrumentation.
		name: 'disable-react-scan-in-release-builds',
		apply: (_config, { command }) => command === 'build',
		config: () => ({
			resolve: {
				alias: {
					'react-scan': fileURLToPath(new URL('./src/lib/react-scan-disabled.ts', import.meta.url)),
				},
			},
		}),
	},
	// TanStack devtools starts an event bus server on port 42069 by default; use a unique port
	// so it doesn't collide with other vite servers.
	devtools({
		eventBusConfig: {
			port: Number(env.DEVFLOW_UI_TANSTACK_DEVTOOLS_PORT) || 42070,
		},
	}),
	tanstackRouter({
		target: 'react',
		autoCodeSplitting: true,
		quoteStyle: 'single',
		semicolons: false,
	}),
	viteReact({
		babel: {
			plugins: ['babel-plugin-react-compiler'],
		},
	}),
	tailwindcss(),
]

// https://vitejs.dev/config/
export default defineConfig({
	base: '/',
	plugins,
	resolve: {
		dedupe: ['react', 'react-dom'],
		alias: {
			'@': fileURLToPath(new URL('./src', import.meta.url)),
		},
	},
	server: {
		host: '127.0.0.1',
		port: Number(env.DEVFLOW_UI_PORT) || 3000,
		strictPort: true,
	},
	worker: {
		// Pierre's highlighter worker imports its wasm chunk, which needs
		// module workers; the default iife format rejects code-splitting.
		format: 'es',
	},
	envDir: '../../',
})
