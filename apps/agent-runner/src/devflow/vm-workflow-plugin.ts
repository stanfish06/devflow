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

/** Restore the guest plugin in place. Returns false when the kernel needs an idle VM for replacement. */
export async function ensureVmWorkflowPlugin(
	lima: LimaRunner,
	vm: string,
	plugin: string,
	otherLeases = false,
): Promise<boolean> {
	const digest = await workflowPluginDigest(plugin, false, digestRuntime)
	// A stale mount can stat entries it can no longer open. Run the same byte check inside the guest.
	const source = `import * as fs from 'node:fs/promises'; import * as path from 'node:path'; import {createHash} from 'node:crypto';
const workflowPluginDigest = ${workflowPluginDigest.toString()}`
	const verify =
		source +
		'\ntry { if (await workflowPluginDigest(process.argv[1], false, { ...fs, ...path, createHash }) !== process.argv[2]) process.exitCode = 42 } catch { process.exitCode = 42 }'
	const shell = ['shell', '--workdir=/', vm, '--']
	const probe = await lima([...shell, 'node', '--input-type=module', '-e', verify, '--', plugin, digest], 30_000)
	if (probe.code === 0) return true
	if (probe.code !== 42) throw new Error(`Cannot verify the workflow plugin in ${vm}: ${probe.stderr || probe.code}`)

	const snapshotDigest = await workflowPluginDigest(plugin, true, digestRuntime)
	const cache = '/run/devflow-workflow-plugins'
	const staging = `${cache}/.install-${randomUUID()}`
	const temp = await mkdtemp(join(tmpdir(), 'devflow-workflow-plugin-'))
	try {
		const archive = join(temp, 'plugin.tar')
		// Archive the verified tree without macOS resource forks or extended attributes.
		await promisify(execFile)('tar', ['--no-xattrs', '-C', plugin, '-cf', archive, '.'], {
			env: { ...process.env, COPYFILE_DISABLE: '1' },
		})
		const input = await open(archive, 'r')
		try {
			// Only the host supplies archive bytes. A 0700 parent protects extracted paths until publication.
			const install = `set -eu
cache=$1
staging=$2
destination=$4
source=devflow-workflow-plugin
install -d -m 0755 "$cache"
mkdir -m 0700 "$staging"
mkdir "$staging/plugin"
cleanup() {
	for path in "$staging/plugin" "$staging/previous"; do
		if [ -d "$path" ]; then
			if mountpoint -q -- "$path"; then umount -l -- "$path"; fi
			rmdir -- "$path"
		fi
	done
	rmdir -- "$staging"
}
trap cleanup EXIT
mount -t tmpfs -o nodev,nosuid "$source" "$staging/plugin"
tar --extract --no-same-owner --file=- --directory="$staging/plugin"
node --input-type=module -e "$5" -- "$staging/plugin" "$3"
chmod -R a+rX,a-w -- "$staging/plugin"
mount -o remount,ro,nodev,nosuid "$staging/plugin"
if [ "$(findmnt -nro SOURCE -T "$destination")" = "$source" ]; then
	# Install beneath the previous repair, then detach it to switch all path lookups atomically.
	# Open handles to the previous tmpfs keep its files alive until the last reader closes.
	code=0
	python3 - "$staging/plugin" "$destination" <<'PYTHON' || code=$?
import ctypes, errno, os, sys
libc = ctypes.CDLL(None, use_errno=True)
def checked(result):
    if result == -1:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return result
at_fdcwd, open_tree_clone = -100, 1
move_mount_f_empty_path, move_mount_beneath, mnt_detach = 4, 0x200, 2
source, destination = map(os.fsencode, sys.argv[1:])
try:
    tree = checked(libc.open_tree(at_fdcwd, source, open_tree_clone))
    checked(libc.move_mount(tree, b"", at_fdcwd, destination, move_mount_f_empty_path | move_mount_beneath))
except AttributeError:
    sys.exit(42)
except OSError as exc:
    if exc.errno in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP):
        sys.exit(42)
    raise
checked(libc.umount2(destination, mnt_detach))
PYTHON
	case "$code" in
	0) ;;
	42|127)
		# Older kernels briefly expose the underlying mount. Wait for other leases to finish.
		[ "$6" = idle ] || exit 43
		mkdir "$staging/previous"
		mount --bind "$destination" "$staging/previous"
		umount -l -- "$destination"
		if ! mount --bind "$staging/plugin" "$destination"; then
			mount --bind "$staging/previous" "$destination"
			exit 1
		fi ;;
	*) exit "$code" ;;
	esac
else
	mount --bind "$staging/plugin" "$destination"
fi`
			const result = await lima(
				[
					...shell,
					'sudo',
					'sh',
					'-c',
					install,
					'sh',
					cache,
					staging,
					snapshotDigest,
					plugin,
					verify,
					otherLeases ? 'busy' : 'idle',
				],
				120_000,
				input.fd,
			)
			if (result.code === 43) return false
			if (result.code !== 0)
				throw new Error(`Cannot restore the workflow plugin in ${vm}: ${result.stderr || result.code}`)
			return true
		} finally {
			await input.close()
		}
	} finally {
		await rm(temp, { recursive: true, force: true })
	}
}
