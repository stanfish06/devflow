data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_vpc" "default" {
  default = true
}

# AZs that offer the instance type; not every us-east-1 AZ has Graviton types.
data "aws_ec2_instance_type_offerings" "selected" {
  location_type = "availability-zone"

  filter {
    name   = "instance-type"
    values = [var.instance_type]
  }
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }

  filter {
    name   = "default-for-az"
    values = ["true"]
  }

  filter {
    name   = "availability-zone"
    values = data.aws_ec2_instance_type_offerings.selected.locations
  }
}

data "aws_ec2_instance_type" "selected" {
  instance_type = var.instance_type
}

# Canonical's public parameter for the current Ubuntu 24.04 image.
data "aws_ssm_parameter" "ubuntu_ami" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/${local.ami_arch}/hvm/ebs-gp3/ami-id"
}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  ami_arch   = contains(data.aws_ec2_instance_type.selected.supported_architectures, "arm64") ? "arm64" : "amd64"
  subnet_ids = sort(data.aws_subnets.default.ids)

  # bun version from the repo's packageManager ("bun@x.y.z") unless set explicitly.
  bun_version = var.bun_version != "" ? var.bun_version : trimprefix(jsondecode(file("${path.module}/../../package.json")).packageManager, "bun@")
}

# ---- Bundle bucket ------------------------------------------------------------

resource "random_id" "bucket_suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "bundles" {
  bucket        = "${var.bucket_prefix}-${random_id.bucket_suffix.hex}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "bundles" {
  bucket                  = aws_s3_bucket.bundles.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "bundles" {
  bucket = aws_s3_bucket.bundles.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# ---- IAM ----------------------------------------------------------------------

resource "aws_iam_role" "devflow" {
  name_prefix = "${var.name}-"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# SSM agent registration, Session Manager and Run Command.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.devflow.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "devflow" {
  name = "bundle-and-secrets"
  role = aws_iam_role.devflow.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadBundles"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = ["${aws_s3_bucket.bundles.arn}/*"]
      },
      {
        Sid      = "ListBundles"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [aws_s3_bucket.bundles.arn]
      },
      {
        Sid    = "ReadSecrets"
        Effect = "Allow"
        Action = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
        Resource = [
          "arn:${local.partition}:ssm:${var.region}:${local.account_id}:parameter${var.ssm_path}",
          "arn:${local.partition}:ssm:${var.region}:${local.account_id}:parameter${var.ssm_path}/*",
        ]
      },
      {
        # SecureString values use the AWS managed key alias/aws/ssm; allow decrypt only through SSM.
        Sid       = "DecryptSecrets"
        Effect    = "Allow"
        Action    = ["kms:Decrypt"]
        Resource  = ["arn:${local.partition}:kms:${var.region}:${local.account_id}:key/*"]
        Condition = { StringEquals = { "kms:ViaService" = "ssm.${var.region}.amazonaws.com" } }
      },
    ]
  })
}

resource "aws_iam_instance_profile" "devflow" {
  name_prefix = "${var.name}-"
  role        = aws_iam_role.devflow.name
}

# ---- Instance -----------------------------------------------------------------

# No inbound rules: access is through SSM Session Manager, which the agent reaches outbound.
resource "aws_security_group" "devflow" {
  name_prefix = "${var.name}-"
  description = "devflow host: no inbound; SSM Session Manager only"
  vpc_id      = data.aws_vpc.default.id

  # Empty list (not an omitted block) so apply also removes rules added by hand.
  ingress = []

  egress {
    description      = "Outbound for SSM, S3, apt, npm and agent APIs"
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_instance" "devflow" {
  ami                    = data.aws_ssm_parameter.ubuntu_ami.insecure_value
  instance_type          = var.instance_type
  subnet_id              = local.subnet_ids[0]
  vpc_security_group_ids = [aws_security_group.devflow.id]
  iam_instance_profile   = aws_iam_instance_profile.devflow.name
  # Public IP for outbound traffic only (the default VPC has no NAT); the security group admits nothing.
  associate_public_ip_address = true

  user_data = templatefile("${path.module}/templates/user_data.sh.tftpl", {
    bucket       = aws_s3_bucket.bundles.id
    region       = var.region
    ssm_path     = var.ssm_path
    bun_version  = local.bun_version
    node_version = var.node_version
    swap_gib     = var.swap_gib
  })

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gib
    encrypted             = true
    delete_on_termination = true
  }

  tags = {
    Name = var.name
  }

  lifecycle {
    # A new AMI or bootstrap script would replace or stop the host and its data; roll those with
    # `terraform apply -replace=aws_instance.devflow` instead.
    ignore_changes = [ami, user_data]

    precondition {
      condition     = length(local.subnet_ids) > 0
      error_message = "No default subnet in ${var.region} is in an AZ that offers ${var.instance_type}. Create a default VPC (aws ec2 create-default-vpc) or pick another instance type."
    }
  }

  depends_on = [aws_iam_role_policy_attachment.ssm_core, aws_iam_role_policy.devflow]
}
