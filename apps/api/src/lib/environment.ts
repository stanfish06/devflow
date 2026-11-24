/**
 * Require an environment variable to be set, with optional default value.
 * @param name Environment variable name
 * @param defaultValue Optional default value if not set
 * @returns The environment variable value
 */
export function requireEnvironment(name: string, defaultValue?: string): string {
	const value = process.env[name] ?? defaultValue
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`)
	}
	return value
}
