# Offline checks with mocked providers: `terraform test` creates nothing in AWS.

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:user/test"
      user_id    = "AIDAEXAMPLEEXAMPLE000"
    }
  }

  mock_data "aws_partition" {
    defaults = {
      partition  = "aws"
      dns_suffix = "amazonaws.com"
    }
  }

  mock_data "aws_vpc" {
    defaults = {
      id  = "vpc-0123456789abcdef0"
      arn = "arn:aws:ec2:us-east-1:123456789012:vpc/vpc-0123456789abcdef0"
    }
  }

  mock_data "aws_ec2_instance_type_offerings" {
    defaults = {
      locations      = ["us-east-1a", "us-east-1b"]
      location_types = ["availability-zone", "availability-zone"]
      instance_types = ["t4g.large", "t4g.large"]
    }
  }

  mock_data "aws_subnets" {
    defaults = {
      ids = ["subnet-0bbbbbbbbbbbbbbbb", "subnet-0aaaaaaaaaaaaaaaa"]
    }
  }

  mock_data "aws_ec2_instance_type" {
    defaults = {
      supported_architectures = ["arm64"]
    }
  }

  mock_data "aws_ssm_parameter" {
    defaults = {
      insecure_value = "ami-0123456789abcdef0"
      value          = "ami-0123456789abcdef0"
      type           = "String"
    }
  }

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::devflow-bundles-mock"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/devflow-mock"
    }
  }

  mock_resource "aws_iam_instance_profile" {
    defaults = {
      arn = "arn:aws:iam::123456789012:instance-profile/devflow-mock"
    }
  }

  mock_resource "aws_instance" {
    defaults = {
      id = "i-0123456789abcdef0"
    }
  }
}

mock_provider "random" {}

run "defaults" {
  command = apply

  assert {
    condition     = length(aws_security_group.devflow.ingress) == 0
    error_message = "The security group must have no ingress rules."
  }

  assert {
    condition     = aws_instance.devflow.iam_instance_profile == aws_iam_instance_profile.devflow.name
    error_message = "The instance must use the devflow instance profile."
  }

  assert {
    condition     = aws_iam_role_policy_attachment.ssm_core.policy_arn == "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
    error_message = "The role must have AmazonSSMManagedInstanceCore."
  }

  assert {
    condition     = aws_instance.devflow.root_block_device[0].encrypted == true
    error_message = "The root volume must be encrypted."
  }

  assert {
    condition     = aws_instance.devflow.root_block_device[0].volume_type == "gp3" && aws_instance.devflow.root_block_device[0].volume_size == 60
    error_message = "The root volume must be 60 GiB gp3 by default."
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.bundles.block_public_acls,
      aws_s3_bucket_public_access_block.bundles.block_public_policy,
      aws_s3_bucket_public_access_block.bundles.ignore_public_acls,
      aws_s3_bucket_public_access_block.bundles.restrict_public_buckets,
    ])
    error_message = "All four bucket public access block settings must be true."
  }

  assert {
    condition     = aws_instance.devflow.ami == "ami-0123456789abcdef0" && strcontains(data.aws_ssm_parameter.ubuntu_ami.name, "/24.04/stable/current/arm64/")
    error_message = "t4g.large must use the Ubuntu 24.04 arm64 AMI."
  }

  assert {
    condition     = aws_instance.devflow.subnet_id == "subnet-0aaaaaaaaaaaaaaaa"
    error_message = "The instance must use the first default subnet (sorted) in an AZ offering the type."
  }

  assert {
    condition     = aws_instance.devflow.metadata_options[0].http_tokens == "required"
    error_message = "IMDSv2 must be required."
  }

  assert {
    condition     = strcontains(aws_instance.devflow.user_data, "BUN_VERSION='${trimprefix(jsondecode(file("../../package.json")).packageManager, "bun@")}'")
    error_message = "user_data must pin bun to the repo's packageManager version."
  }

  assert {
    condition     = strcontains(aws_instance.devflow.user_data, "BUCKET='${aws_s3_bucket.bundles.id}'")
    error_message = "The deploy script must read from the bundle bucket."
  }
}

run "amd64_instance_type" {
  command = plan

  variables {
    instance_type = "t3.large"
  }

  override_data {
    target = data.aws_ec2_instance_type.selected
    values = {
      supported_architectures = ["x86_64"]
    }
  }

  assert {
    condition     = strcontains(data.aws_ssm_parameter.ubuntu_ami.name, "/24.04/stable/current/amd64/")
    error_message = "An x86_64 instance type must use the amd64 AMI."
  }
}
