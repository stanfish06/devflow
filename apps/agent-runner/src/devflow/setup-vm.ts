/**
 * `bun run devflow setup-vm`: build the provisioned base VM (Ubuntu image download, toolchain
 * install) before `devflow up`, so the first VM task clones it instead of waiting on it.
 * apps/launcher/src/devflow.ts runs this with the daemon's environment, so both name the same base.
 */
import { defaultRunner, VmManager, vmConfigFromEnv } from './vm-sandbox'

const config = vmConfigFromEnv()
const manager = new VmManager(config, defaultRunner(config.limactl, { showProgress: true }))
console.log(`Preparing the devflow base VM (${config.diskGiB} GiB disk) with ${config.limactl}...`)
const name = await manager.ensureBase()
console.log(`Base VM ${name} is ready; VM tasks clone it.`)
