import { readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// Remote archives are staged on the destination filesystem so each file can be renamed into place.
export const REMOTE_STAGING = '.devflow-incoming'

export function installRemoteTree(source: string, destination: string): void {
	const install = (from: string, to: string) => {
		const previous = new Map(readdirSync(to, { withFileTypes: true }).map((entry) => [entry.name, entry]))
		if (to === destination) {
			previous.delete('node_modules')
			previous.delete(REMOTE_STAGING)
		}

		for (const entry of readdirSync(from, { withFileTypes: true })) {
			const staged = join(from, entry.name)
			const target = join(to, entry.name)
			const old = previous.get(entry.name)
			previous.delete(entry.name)
			if (entry.isDirectory() && old?.isDirectory()) {
				// Lima and Docker bind mounts hold the directory inode across deployments.
				install(staged, target)
			} else {
				if (old && entry.isDirectory() !== old.isDirectory()) rmSync(target, { recursive: true, force: true })
				renameSync(staged, target)
			}
		}
		for (const name of previous.keys()) rmSync(join(to, name), { recursive: true, force: true })
	}
	install(source, destination)
}

if (import.meta.main) {
	const source = process.argv[2]
	if (!source) throw new Error('Expected a staged remote archive')
	installRemoteTree(source, process.cwd())
}
