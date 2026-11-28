## Setup
```sh
nix develop
bun install
bun run devflow setup   # once: keys, config, containers, database migrations, agent image
bun run devflow up      # Ctrl-C stops everything
```

Open https://app.devflow.localhost:47443. You are signed in as the local user.

1. Settings → Projects → Add project: the repository's remote (`git@github.com:you/repo.git`), a
   name, and the path of an existing checkout. Each task gets its own worktree and branch.
2. Pick a size in the composer: Small (implement, then PR), Medium (RPI: research questions →
   research → design → outline → implement → PR), Large (PRD/TDD), or "Don't know yet".
3. Type the prompt and send. Approve commands in the thread when the permission mode asks.

Other commands:

| Command | Does |
|---|---|
| `bun run devflow up --dev` | UI on the Vite dev server with hot reload |
| `bun run devflow status` | URLs and container state |
| `bun run devflow down` | stop the containers (data stays in Docker volumes) |
| `bun run devflow env` | the generated environment (secrets masked) |
| `bun run devflow api --help` | the CLI against this stack, e.g. `bun run devflow api sync tasks` |
| `bun run devflow e2e` | Playwright end-to-end tests against the running stack (installed Chrome) |
| `bun run devflow desktop` | the native desktop client (`apps/desktop`, macOS only) against the running stack; needs `nix develop` for Rust, extra arguments go to cargo (e.g. `--release`) |
| `bun run devflow up --port 48443` | run on 48443 (all ports shifted with it); later commands keep the port |
| `bun run devflow remote <ssh-host>` | make another machine (e.g. a `cloud` VM: `bun run devflow remote vm`) a host of this server, listed in the host picker while it runs |
| `bun run devflow vm [ls \| shell <name> \| stop <name> \| rm <name>]` | list the agent VMs, open a shell in one, stop or delete one |
| `bun run devflow clean [--yes] [--force] [--days N] [--no-gh]` | show, then with `--yes` free, disk: worktrees (and VMs) of archived, done or merged tasks, `node_modules` of worktrees idle `N` days (default 7), logs older than 14 days. Worktrees with uncommitted or unpushed work or a running session are kept (`--force` drops the first two) |

## Agent VMs

A project whose agents need Docker (or a whole OS) can run them in Lima VMs: Settings → Projects →
Sandbox → VM. Each new task of such a project then runs either in its own VM (default for Medium,
Large and "Don't know yet") or in the host's shared VM (default for Small); the composer's VM menu
overrides the default. Claude Code and Codex both run inside the VM, with Docker, nix, mise, bun,
Node and gh installed.

- To size a new task VM, select **Own VM**, open its menu, enter **vCPUs** and **Memory (GiB)**, and
  select **Apply** before starting the task. Each blank field inherits its default from the host
  running the VM. Later sessions in the task reuse that VM.
- The first VM provisions a base image once (several minutes, about 5 GB); every VM after that is a
  full copy of it, so each VM costs disk space as it fills.
- Host paths are mounted at the same paths in the VM; `~/.codex` is mounted for Codex sessions.
- After pulling this change, run `bun run devflow setup` once to apply its database migration.
- Every port at or above 1024 that something listens on in a VM is forwarded to `127.0.0.1` on the
  host running the daemon, on the same port when it is free; the task's details list the mapping.
  A port the guest listens on only on its loopback (`127.0.0.1`, `::1`) gets any free host port,
  so a guest's build cache or language server never takes the port of the host's own copy.
- A VM stops `DEVFLOW_VM_IDLE_STOP_MINUTES` after its last session; a task's own VM is deleted when
  the task is archived. A task deleted without being archived keeps its VM until
  `bun run devflow vm rm <name>`.
- A task's own VM mounts only that task's worktrees; the shared VM mounts every task's. Both mount
  `~/.devflow/run` (every session's GitHub credentials) and the repositories' git directories.
- The Docker sandbox applies to Claude Code only; Codex keeps its own sandbox on the host unless the
  project's sandbox is VM.

## Settings

Copy `.env.example` to `.env` at the repository root and set what you use:

| Variable | Default | Effect |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | unset | Claude subscription token for sandboxed agents and helper calls |
| `DEVFLOW_AGENT_SANDBOX` | `docker` | sandbox for projects left at "Host default": `docker`, `vm` (shared Lima VM) or `none` (on the host) |
| `DEVFLOW_VM_CPUS`, `DEVFLOW_VM_MEMORY_GIB`, `DEVFLOW_VM_DISK_GIB` | `4`, `8`, `60` | size of each agent VM |
| `DEVFLOW_VM_IDLE_STOP_MINUTES` | `60` | stop a VM this long after its last session; `0` keeps it running |
| `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET` | placeholders | your own GitHub App, for the GitHub issue picker and PR status in the UI |
| `GITHUB_ACCOUNT_TOKEN_KEY` | generated into `.env` once | encrypts the GitHub accounts stored in Settings → GitHub accounts; changing it means adding them again |
| `DEVFLOW_HOME` | `~/.devflow` | config, keys, logs, sandbox Claude config |

## Artifacts

- Config and keys: `~/.devflow/config.json`, `~/.devflow/keys/`.
- Logs: `~/.devflow/logs/` (daemon logs `devflowd-*.jsonl`); `bun run devflow up` prints every
  service's output prefixed with its name.
- Data: Docker volumes `devflow_postgresql_data`, `devflow_minio_data`, `devflow_redis`,
  `devflow_durable-streams-data`.
- Task worktrees: `~/.devflow/workspaces/`; task documents: `<worktree>/.devflow/tasks/`.
