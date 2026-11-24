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
| `bun run devflow up --port 48443` | run on 48443 (all ports shifted with it); later commands keep the port |
| `bun run devflow remote <ssh-host>` | make another machine (e.g. a `cloud` VM: `bun run devflow remote vm`) a host of this server, listed in the host picker while it runs |

## Settings

Copy `.env.example` to `.env` at the repository root and set what you use:

| Variable | Default | Effect |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | unset | Claude subscription token for sandboxed agents and helper calls |
| `DEVFLOW_AGENT_SANDBOX` | `docker` | `none` runs Claude Code on the host |
| `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET` | placeholders | your own GitHub App, for the GitHub issue picker and PR status in the UI |
| `DEVFLOW_HOME` | `~/.devflow` | config, keys, logs, sandbox Claude config |

## Artifacts

- Config and keys: `~/.devflow/config.json`, `~/.devflow/keys/`.
- Logs: `~/.devflow/logs/` (daemon logs `devflowd-*.jsonl`); `bun run devflow up` prints every
  service's output prefixed with its name.
- Data: Docker volumes `devflow_postgresql_data`, `devflow_minio_data`, `devflow_redis`,
  `devflow_durable-streams-data`.
- Task worktrees: `~/.devflow/workspaces/`; task documents: `<worktree>/.devflow/tasks/`.
