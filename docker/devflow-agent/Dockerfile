# The daemon runs each Claude Code process in a container from this image
# (apps/agent-runner/src/devflow/docker-sandbox.ts).
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.331
ARG GH_VERSION=2.104.0

# Tools the agent commonly shells out to.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates curl ripgrep jq python3 python3-pip python3-venv openssh-client \
	&& rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && npm cache clean --force

# GitHub CLI for the PR stage (rpi:describe-pr). The daemon passes GH_TOKEN in.
RUN arch="$(dpkg --print-architecture)" \
	&& curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz" \
	| tar -xz -C /tmp && mv "/tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh && rm -rf /tmp/gh_*

# Bind-mounted repos are owned by the host user's uid; trust them for git.
RUN git config --system safe.directory '*'
# No SSH keys in the sandbox: push GitHub remotes over HTTPS with gh as the credential helper.
RUN git config --system url."https://github.com/".insteadOf "git@github.com:" \
	&& git config --system credential."https://github.com".helper '!gh auth git-credential'

# entrypoint.sh appends a passwd entry for the runtime uid; /etc/passwd must be writable for that.
COPY entrypoint.sh /usr/local/bin/devflow-entrypoint
RUN chmod 666 /etc/passwd
ENTRYPOINT ["/usr/local/bin/devflow-entrypoint"]
