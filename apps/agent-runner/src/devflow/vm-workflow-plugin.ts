import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdtemp, open, readFile, readdir, readlink, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'

import type { LimaRunner } from './vm-sandbox'
const digestRuntime = { createHash, lstat, readFile, readdir, readlink, realpath, isAbsolute, join, relative, sep }

/** The daemon sends this function to the guest's Node runtime. Take all module dependencies as arguments. */
async function workflowPluginDigest(
	root: string,
	copying: boolean,
	{ createHash, lstat, readFile, readdir, readlink, realpath, isAbsolute, join, relative, sep }: typeof digestRuntime,
): Promise<string> {
	const canonicalRoot = await realpath(root)
	const entries = await readdir(root, { recursive: true, withFileTypes: true })
	const files = entries.map((entry) => relative(root, join(entry.parentPath, entry.name))).sort()
	const digest = createHash('sha256')
	let regularFiles = 0
	for (const name of files) {
		const path = join(root, name)
		const stat = await lstat(path)
		let contents = ''
		if (stat.isFile()) {
			regularFiles++
			contents = createHash('sha256')
				.update(await readFile(path))
				.digest('hex')
		} else if (stat.isSymbolicLink()) {
			contents = await readlink(path)
			if (copying) {
				const target = relative(canonicalRoot, await realpath(path))
				if (target === '..' || target.startsWith('..' + sep) || isAbsolute(target)) {
					throw new Error(`Cannot copy a workflow plugin link outside its root: ${path}`)
				}
			}
		} else if (!stat.isDirectory()) {
			throw new Error(`Unsupported file type in workflow plugin: ${path}`)
		}
		// Read-only mounts change write permissions. Executable files must remain executable in the snapshot.
		digest.update(JSON.stringify([name, stat.mode & 0o170000, Boolean(stat.mode & 0o111), contents]))
	}
	if (!regularFiles) throw new Error(`The workflow plugin contains no regular files: ${root}`)
	return digest.digest('hex')
}

/** Restore a replaced source directory at the same guest path while other processes keep using the VM. */
export async function ensureVmWorkflowPlugin(lima: LimaRunner, vm: string, plugin: string): Promise<void> {
	const digest = await workflowPluginDigest(plugin, false, digestRuntime)
	// A stale mount can stat entries it can no longer open. Run the same byte check inside the guest.
	const source = `import * as fs from 'node:fs/promises'; import * as path from 'node:path'; import {createHash} from 'node:crypto';
const workflowPluginDigest = ${workflowPluginDigest.toString()}`
	const verify =
		source +
		'\ntry { if (await workflowPluginDigest(process.argv[1], false, { ...fs, ...path, createHash }) !== process.argv[2]) process.exitCode = 42 } catch { process.exitCode = 42 }'
	const shell = ['shell', '--workdir=/', vm, '--']
	const probe = await lima([...shell, 'node', '--input-type=module', '-e', verify, '--', plugin, digest], 30_000)
	if (probe.code === 0) return
	if (probe.code !== 42) throw new Error(`Cannot verify the workflow plugin in ${vm}: ${probe.stderr || probe.code}`)

	const snapshotDigest = await workflowPluginDigest(plugin, true, digestRuntime)
	const run = async (script: string, args: string[], stdin?: number) => {
		const result = await lima([...shell, 'sudo', 'sh', '-c', script, 'sh', ...args], 120_000, stdin)
		if (result.code !== 0)
			throw new Error(`Cannot restore the workflow plugin in ${vm}: ${result.stderr || result.code}`)
	}
	const cache = '/run/devflow-workflow-plugins'
	const staging = `${cache}/.install-${randomUUID()}`
	const temp = await mkdtemp(join(tmpdir(), 'devflow-workflow-plugin-'))
	try {
		const archive = join(temp, 'plugin.tar')
		await promisify(execFile)('tar', ['-C', plugin, '-cf', archive, '.'])
		const input = await open(archive, 'r')
		try {
			// Only the host supplies archive bytes. A 0700 parent protects extracted paths until publication.
			const install = `set -eu
cache=$1
staging=$2
snapshot="$cache/$3"
destination=$4
install -d -m 0755 "$cache"
mkdir -m 0700 "$staging"
trap 'rm -rf -- "$staging"' EXIT
mkdir "$staging/plugin"
tar --extract --no-same-owner --file=- --directory="$staging/plugin"
node --input-type=module -e "$5" -- "$staging/plugin" "$3"
chmod -R a+rX,a-w -- "$staging/plugin"
if [ ! -d "$snapshot" ]; then mv -T -- "$staging/plugin" "$snapshot"; fi
mount -o bind,ro -- "$snapshot" "$destination"`
			await run(install, [cache, staging, snapshotDigest, plugin, verify], input.fd)
		} finally {
			await input.close()
		}
	} finally {
		await rm(temp, { recursive: true, force: true })
	}
}
