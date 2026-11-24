variable "region" {
  description = "AWS region for every resource."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Name tag and prefix for the instance, role and security group."
  type        = string
  default     = "devflow"
}

variable "instance_type" {
  description = "EC2 instance type. The AMI architecture (arm64 or amd64) follows from it."
  type        = string
  default     = "t4g.large"
}

variable "root_volume_gib" {
  description = "Root gp3 volume size in GiB (Docker volumes, node_modules, agent worktrees)."
  type        = number
  default     = 60
}

variable "swap_gib" {
  description = "Swap file size in GiB; 0 disables it."
  type        = number
  default     = 4
}

variable "bucket_prefix" {
  description = "Bundle bucket name prefix; a random hex suffix is appended."
  type        = string
  default     = "devflow-bundles"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{2,45}$", var.bucket_prefix))
    error_message = "bucket_prefix must be 3-46 lowercase letters, digits or hyphens."
  }
}

variable "ssm_path" {
  description = "SSM Parameter Store path holding secrets; each parameter's basename becomes an env var."
  type        = string
  default     = "/devflow"

  validation {
    condition     = can(regex("^(/[A-Za-z0-9_.-]+)+$", var.ssm_path))
    error_message = "ssm_path must start with / and must not end with /."
  }
}

variable "bun_version" {
  description = "bun version installed at first boot. Empty reads packageManager from the repo's package.json."
  type        = string
  default     = ""
}

variable "node_version" {
  description = "Node.js version (nodejs.org release) for CLIs that run under node, e.g. codex."
  type        = string
  default     = "24.22.3"
}
