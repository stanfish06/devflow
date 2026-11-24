# devflow on one AWS VM

Runs `bun run devflow up --headless` as a systemd service on one EC2 instance. The instance has no inbound ports; you reach it through SSM Session Manager.

## What it creates

| Resource | Details |
| --- | --- |
| EC2 instance | Ubuntu 24.04 (Canonical's SSM parameter, arm64 for Graviton types), `t4g.large` (2 vCPU, 8 GiB), 60 GiB encrypted gp3 root volume, IMDSv2 only, in a default subnet of the default VPC |
| Security group | No ingress rules; all egress (SSM, S3, apt, npm, agent APIs) |
| IAM role + instance profile | `AmazonSSMManagedInstanceCore`, read on the bundle bucket, `ssm:GetParameter*` on `/devflow` and `/devflow/*`, `kms:Decrypt` through SSM only |
| S3 bucket | `devflow-bundles-<hex>`, private, SSE-S3, `force_destroy = true`; holds `devflow.tar.gz` |

First boot (`templates/user_data.sh.tftpl`, log in `/var/log/devflow-bootstrap.log`) installs Docker, Docker Compose, Caddy, lsof, git, jq, AWS CLI v2, Node.js 24, bun (version from `package.json` `packageManager`), and the `claude` and `codex` CLIs for user `devflow`. It writes:

- `/opt/devflow/bin/deploy`: downloads `s3://<bucket>/devflow.tar.gz` into `/opt/devflow/app` (previous tree kept in `/opt/devflow/app.prev`), runs `bun install`, writes every SSM parameter under `/devflow/` to `/opt/devflow/secrets.env` (mode 600, `NAME=value`, name = parameter basename), runs `bun run devflow setup` on the first deploy, then restarts the service. It never touches `/home/devflow/.devflow` (config, keys, logs) or Docker volumes.
- `devflow.service`: runs as `devflow` from `/opt/devflow/app` with `secrets.env` loaded; it starts after the first deploy.

## Prerequisites

- AWS credentials for the target account (`aws sts get-caller-identity` works).
- `aws` CLI v2 and `session-manager-plugin` on the laptop. `nix develop` at the repo root provides both, plus `terraform`.

## Commands

From `infra/terraform`:

```sh
terraform init
terraform apply                    # prints instance_id, bundle_bucket and next_steps
terraform output -raw next_steps
```

Store secrets (each parameter under `/devflow/` becomes an environment variable of the service):

```sh
aws ssm put-parameter --region us-east-1 --name /devflow/CLAUDE_CODE_OAUTH_TOKEN \
  --type SecureString --overwrite --value "$CLAUDE_CODE_OAUTH_TOKEN"
```

Deploy and open the UI, from the repo root:

```sh
bun run devflow aws push --instance <instance_id> --bucket <bundle_bucket> --region us-east-1
bun run devflow aws tunnel --instance <instance_id> --region us-east-1
```

Shell on the host and service logs:

```sh
aws ssm start-session --region us-east-1 --target <instance_id>
sudo journalctl -u devflow -f
```

Destroy (deletes the instance, its volume and all devflow data on it, and the bucket):

```sh
terraform destroy
```

Changes to `templates/user_data.sh.tftpl` and new Ubuntu AMIs are ignored for an existing instance. To apply them, replace it, which also wipes its data: `terraform apply -replace=aws_instance.devflow`.

## Tests

`terraform test` runs `tests/devflow.tftest.hcl` with mocked providers and creates nothing. It checks that the security group has no ingress, the instance uses the instance profile, the root volume is encrypted, and the bucket blocks public access.
