# EVIDENCE: what devflow copied from HumanLayer and what it changed

## Baseline

devflow's first commit, `f4b0c5d`, is an exact export of the HumanLayer repository at
`fb899cd8cba767f0392708efc20d00938dec6a87` (`git archive fb899cd8 | tar -x`), 6,016 files. Every
change since is a diff against that commit. Reproduce the lists below with:

```sh
git diff --stat f4b0c5d            # all changes (run `git add -N .` first to include new files)
git diff f4b0c5d -- <path>         # one file
```

HumanLayer is Apache-2.0 (`LICENSE`, `NOTICE` kept unchanged). The copied files keep their paths
and package names (`@humanlayer/*`), so the mapping from HumanLayer file to devflow file is the
identity: `humanlayer/<path>` at `fb899cd8` → `devflow/<path>`.

## Summary

| | Files | Lines |
|---|---|---|
| Copied from HumanLayer, unchanged | 5,993 | all |
| Copied from HumanLayer, edited | 23 | +106 / −44 |
| New in devflow | 27 (incl. this file and DEVFLOW.md) | about 3,700 |
| Removed | 0 | 0 |

Runtime code that runs unchanged from HumanLayer: the minimalist UI (`apps/riptide-ui/src/minimalist`
and everything it imports), the API (`apps/riptide-api`), the Electric proxy
(`apps/riptide-electric-proxy`), the daemon (`apps/riptide-daemon`, including the Claude session
runner, approvals, interrupts, worktrees, artifact sync), the RPI skills
(`apps/riptide-rpi-claude-plugin`), the auto-advance rules
(`apps/riptide-api/src/orpc/daemon/sessions/check-auto-advance.ts`), next-step extraction
(`packages/ai/src/agents/extract-next-step`), the stale-daemon sweeper (`apps/stale-daemon-sweeper`),
the database schema and migrations (`packages/db`), the API contract
(`contracts/riptide-api-contract`), the CLI (`apps/cli`), and `docker-compose.yaml` (Postgres,
Electric, MinIO, Redis, durable streams).

## Edited HumanLayer files

| File | Change | Why |
|---|---|---|
| `apps/riptide-api/src/workos.ts` | +11 −7: use the local in-memory WorkOS when `DEVFLOW_LOCAL_AUTH=true` | single user, no WorkOS account |
| `apps/riptide-api/src/lib/workos.ts` | +2 −1: JWKS URL from `DEVFLOW_JWKS_URL` when set | tokens are signed locally |
| `apps/riptide-api/src/auth/jwks-cache.ts` | +16 −10: read the local key instead of fetching it over HTTP in local-auth mode (fetch moved into a method) | the API would otherwise fetch its own JWKS before it listens |
| `apps/riptide-api/src/app.ts` | +3: register `/devflow/auth/*` routes in local-auth mode | serves the local session token and JWKS |
| `apps/riptide-electric-proxy/src/auth/effect/workos.service.ts`, `src/lib/workos.ts` | +2 −1, +1 −1: JWKS URL from `DEVFLOW_JWKS_URL` | same as the API |
| `apps/riptide-api/src/lib/reliable-language-model.ts` | +6: return the subscription model when `DEVFLOW_AI_PROVIDER=claude-code` | helper calls without API keys |
| `packages/ai/src/providers/models.ts` | +5 −2: same switch in `resolveModel` | same |
| `packages/ai/src/agents/generate-learn-questions/…ts`, `context-shards/generate-context-shard-candidates.ts` | +3 −2 each: `resolveModel('sonnet'/'haiku')` instead of `anthropic(...)` | these two bypassed `resolveModel` |
| `packages/ai/package.json` | +3 −1: dependency `ai-sdk-provider-claude-code@3.7.1`, export of the new provider file | as above |
| `apps/riptide-daemon/src/effects/services/claude-sessions/query-options.ts` | +8: `spawnClaudeCodeProcess` set to the Docker sandbox spawner when enabled | agent sandbox requirement |
| `apps/riptide-daemon/src/start.ts` | +9 −1: remove stale sandbox containers at start; route `codex` sessions in the `codelayer` executor slot to the app-server executor | sandbox and Codex app-server requirements |
| `apps/cli/src/auth/index.ts` | +19: get the token from `/devflow/auth/session` in local-auth mode | CLI without WorkOS login |
| `apps/riptide-ui/vite.config.ts` | +8: alias `@workos-inc/authkit-react` to the local provider when `VITE_PUBLIC_DEVFLOW_LOCAL_AUTH=true` | all 87 `useAuth()` call sites stay unchanged |
| `apps/riptide-ui/src/minimalist/MinimalistFrame.tsx` | −2: no beta banner | devflow has only the minimalist UI; the banner offered the old one |
| `apps/riptide-ui/src/minimalist/components/SettingsLayout.tsx` | −7: no Organization settings group (Members, Access requests) | single user |
| `apps/riptide-ui/src/minimalist/components/ComposerControls.tsx` | +1 −2: issue menu shows GitHub only | no Linear or Jira |
| `apps/riptide-ui/src/minimalist/components/Sidebar.tsx`, `AppShell.tsx`, `src/components/documentTitle.ts`, `index.html` | 1 line each: product name "devflow" | name |
| `package.json` (root) | +2 −1: `devflow` script | entry point |

## New files

All of these are written for devflow; none is copied, except where stated.

| File | Lines | What | Verified by |
|---|---|---|---|
| `apps/riptide-api/src/devflow/local-workos-service.ts` | 609 | **Copied** from HumanLayer's `apps/riptide-api/test/mocks/workos-service.mock.ts`; only the import path differs (`diff` shows one line) | used by every authenticated request |
| `apps/riptide-api/src/devflow/local-auth.ts` | 138 | issues RS256 tokens with WorkOS's claim shape, serves the JWKS, seeds the in-memory WorkOS with the one user/org | UI, CLI, daemon and Electric proxy all authenticate through it |
| `apps/riptide-ui/src/integrations/devflow/local-authkit.tsx` | 121 | `AuthKitProvider`/`useAuth` with AuthKit's type, backed by `/devflow/auth/session` | UI loads signed in (Chrome, e2e) |
| `packages/ai/src/providers/claude-code-subscription.ts` | 68 | AI SDK model on the Claude Agent SDK (subscription); new instance per call; reports `StructuredOutput` results as text | titles and next-step suggestions appear; extraction 2 s per call |
| `apps/riptide-daemon/src/devflow/docker-sandbox.ts` | 168 | runs Claude Code in `docker run -i` with same-path mounts, allowlisted env, separate Claude config dir | agent reports `Linux` / `aarch64`; resume after restart (Chrome, e2e) |
| `apps/riptide-daemon/src/devflow/codex-app-server.ts` | 380 | Codex sessions over `codex app-server` JSON-RPC; maps items to Riptide events; approvals through Riptide's approval rows | Codex task in Chrome (bypass mode); e2e test |
| `docker/devflow-agent/Dockerfile`, `entrypoint.sh` | 35 | sandbox image: Node 22, git, ripgrep, python3, Claude Code 2.1.331, gh 2.104.0 | built locally, `gh api user` works inside |
| `apps/devstack/src/devflow.ts` | 737 | `devflow setup/up/down/status/env/e2e/aws` and CLI forwarding. Reuses devstack's `renderStackEnvLines` and seed code; Caddy block copied from devstack's `renderCaddyConfig` | used for every run in this session |
| `apps/devflow-e2e/**` | 296 | Playwright tests (see Verification) | runs in installed Chrome |
| `infra/terraform/**` | 785 | one EC2 VM (no inbound ports, SSM), S3 bundle bucket, IAM, cloud-init, systemd unit, tests | `fmt`, `validate`, `terraform test` (2 pass), real `plan` (10 to add). **Not applied.** |
| `flake.nix`, `flake.lock` | 113 | dev shell: bun, Node 24, Caddy, git, gh, jq, docker CLI, compose, AWS CLI, SSM plugin, Terraform 1.17.2 (HashiCorp zip, pinned SHA-256) | `nix develop` on aarch64-darwin; Linux shells evaluate but were not built |
| `DEVFLOW.md`, `EVIDENCE.md` | | docs | |

## Disabled without deleting code

| Feature | How | Why |
|---|---|---|
| WorkOS login, orgs, invitations | local auth (above) | single user |
| Stripe billing | `IS_BILLING_ENFORCEMENT_ENABLED=false`; placeholder keys; `STRIPE_API_BASE_URL` points at a closed local port | not wanted |
| Resend email, Slack, PostHog | placeholder config; API base URLs point at `http://127.0.0.1:9` | no data leaves the machine |
| Linear, Jira | placeholder OAuth config; removed from the composer's issue menu | not wanted |
| GitHub App (issue picker, PR status) | placeholder key and closed `GITHUB_API_BASE_URL` unless `GITHUB_APP_*` is set in `.env` | needs your own GitHub App |
| riptide-cloud, Tauri, Electron apps | not started | not needed for a local web UI |

## Adaptations in behaviour

- **Database.** Postgres 18 in Docker, as in Riptide, not SQLite. Riptide's SQL, migrations and
  Electric sync are Postgres-specific; keeping Postgres keeps them byte-identical.
- **Containers.** Postgres, Electric, MinIO, Redis and durable streams run from HumanLayer's
  `docker-compose.yaml`, under project name `devflow` and ports 473xx–479xx.
- **TLS.** Caddy serves `https://{app,api,sync,s3}.devflow.localhost:47443` (HTTP/2, needed for
  Electric's long-polls), as HumanLayer's devstack does, on one port.
- **Sweeper.** `apps/stale-daemon-sweeper` runs every 60 s inside `devflow up` (Riptide: Lambda on
  `rate(1 minute)`).
- **Stop order.** `devflow up` stops the daemon first so its graceful shutdown can record active
  sessions as failed through the API, then the rest; crashed services restart after 2 s.
- **Helper models.** Session titles, next-step extraction and summaries use Claude Haiku/Sonnet
  through Claude Code on the subscription instead of the Anthropic/OpenAI APIs.
- **Agent sandbox.** Claude Code runs in a Docker container per session; Codex runs on the host
  under Codex's own sandbox (`workspace-write`), because sandboxing it in Docker would mount your
  whole `~/.codex` (8.8 GB here, every past session) into the container.

## Limits

- Sessions started with `DEVFLOW_AGENT_SANDBOX=none` cannot be resumed after switching the sandbox
  on (their Claude transcript is in `~/.claude`, the sandbox uses `~/.devflow/sandbox/claude`).
  Your `~/.claude` skills, hooks and settings are not loaded inside the sandbox.
- A daemon that is killed (not stopped) leaves its running session in `running` until the sweeper
  marks it `lost` after 10 minutes of no events (Riptide's rule); sending a message then resumes it.
- Next-step extraction and auto-advance run fire-and-forget in the API (Riptide's design); an API
  restart while they run drops them, and the "Continue" button does not appear for that turn.
  Starting the next stage with its `/rpi:...` command still works.
- Codex sessions: events appear when each item completes (no token streaming); the "Changes" count
  is filled by Claude-only hooks, so it stays empty for Codex turns until the next diff capture.
  Codex approvals are wired to Riptide's approval rows but were only exercised in bypass mode.
- GitHub issue picker and PR status in the UI need your GitHub App; agents open PRs with `gh`.
- The AWS VM has not been created; its boot and deploy scripts have not run on a real instance.

## Verification

See the end of this file, filled in from the last test run.
