#!/usr/bin/env bash
# Pre-pull scanner/apply worker images onto the Docker Engine that Agentic uses
# via /var/run/docker.sock. Run this on the EC2 host, not inside a container.
set -euo pipefail

# Names match Agentic Layer (environment.py, terraform_apply.py, iac_scan.py, etc.).
images=(
  alpine
  alpine/git
  hashicorp/terraform:1.9.0
  bearer/bearer:latest-amd64
  anchore/syft
  anchore/grype
  zricethezav/gitleaks:v8.21.2
  bridgecrew/checkov:3.2.334
  zaproxy/zap-stable:2.16.1
  prowlercloud/prowler:5.8.0
)

printf 'Pulling %s worker images for scans, DAST, and Terraform apply...\n' "${#images[@]}"
for image in "${images[@]}"; do
  printf '  %s\n' "$image"
  docker pull "$image"
done
printf 'Worker images ready.\n'
