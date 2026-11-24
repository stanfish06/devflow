export function resolveElectricProxyPort(
	env: Partial<Pick<NodeJS.ProcessEnv, 'DEVFLOW_ELECTRIC_PROXY_PORT' | 'PORT'>>,
): number {
	return Number(env.DEVFLOW_ELECTRIC_PROXY_PORT ?? env.PORT) || 8888
}
