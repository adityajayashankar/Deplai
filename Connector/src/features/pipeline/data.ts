import type { ArchNode, CostItem, ScaFinding, SastFinding, Severity, Stage } from './types';

export const STAGES: Stage[] = [
  { id: 0, key: 'preflight', label: 'Preflight checks', group: null, status: 'success', duration: '1.8s' },
  { id: 1, key: 'scan', label: 'run_scan (SAST/SCA)', group: 'loop', status: 'success', duration: '4m 32s' },
  { id: 2, key: 'kg', label: 'KG Agent analysis', group: 'loop', status: 'success', duration: '22s' },
  { id: 3, key: 'remediate', label: 'Remediate vulnerabilities', group: 'loop', status: 'success', duration: '2m 14s' },
  { id: 4, key: 'pr', label: 'Create PR', group: 'loop', status: 'success', duration: '4s' },
  { id: 4.5, key: 'merge', label: 'Merge gate', group: 'loop', status: 'active', gate: true },
  { id: 4.6, key: 'postmerge', label: 'Post-merge actions', group: 'loop', status: 'pending' },
  { id: 6, key: 'qa', label: 'Q/A context gathering', status: 'pending', gate: true },
  { id: 7, key: 'arch', label: 'Generate diagram + estimate_cost', status: 'pending' },
  { id: 7.5, key: 'approve', label: 'Approve architecture + cost', status: 'pending', gate: true },
  { id: 8, key: 'iac', label: 'Generate terraform (+ansible)', status: 'pending' },
  { id: 9, key: 'gitops', label: 'GitOps (budget check)', status: 'pending', gate: true },
  { id: 10, key: 'deploy', label: 'Deploy on AWS', status: 'pending', gate: true },
];

export const SAST_FINDINGS: SastFinding[] = [
  { id: 'CWE-89', title: 'SQL Injection', severity: 'critical', count: 3, file: 'app/db/queries.py', line: 47, desc: 'User input concatenated directly into SQL query without parameterization.' },
  { id: 'CWE-79', title: 'Cross-Site Scripting (XSS)', severity: 'critical', count: 2, file: 'frontend/src/components/UserInput.tsx', line: 112, desc: 'Unsanitized user content rendered via dangerouslySetInnerHTML.' },
  { id: 'CWE-798', title: 'Hardcoded Credentials', severity: 'high', count: 5, file: 'config/settings.py', line: 23, desc: 'Database password and API secret embedded in source code.' },
  { id: 'CWE-22', title: 'Path Traversal', severity: 'high', count: 2, file: 'app/routes/files.py', line: 88, desc: 'User-supplied path not validated, allowing directory traversal.' },
  { id: 'CWE-502', title: 'Deserialization of Untrusted Data', severity: 'high', count: 1, file: 'app/utils/cache.py', line: 31, desc: 'pickle.loads() called on data from Redis without validation.' },
  { id: 'CWE-200', title: 'Information Exposure', severity: 'medium', count: 8, file: 'app/middleware/error.py', line: 15, desc: 'Stack traces and debug info exposed in production error responses.' },
  { id: 'CWE-327', title: 'Weak Cryptography', severity: 'medium', count: 3, file: 'app/auth/tokens.py', line: 67, desc: 'MD5 used for password hashing instead of bcrypt/argon2.' },
  { id: 'CWE-611', title: 'XML External Entity', severity: 'medium', count: 1, file: 'app/parsers/xml_parser.py', line: 9, desc: 'XML parser configured with external entity resolution enabled.' },
];

export const SCA_FINDINGS: ScaFinding[] = [
  { cve: 'CVE-2024-21413', pkg: 'requests', ver: '2.28.1', fixed: '2.31.0', severity: 'critical', epss: '0.94', desc: 'SSRF via malformed URL in redirect handling.' },
  { cve: 'CVE-2024-35195', pkg: 'requests', ver: '2.28.1', fixed: '2.32.0', severity: 'high', epss: '0.71', desc: 'Certificate verification bypass via proxy.' },
  { cve: 'CVE-2023-43804', pkg: 'urllib3', ver: '1.26.13', fixed: '2.0.7', severity: 'high', epss: '0.68', desc: 'Cookie header leakage across redirects.' },
  { cve: 'CVE-2024-37891', pkg: 'urllib3', ver: '1.26.13', fixed: '2.2.2', severity: 'medium', epss: '0.52', desc: 'Proxy-Authorization header not stripped on redirect.' },
  { cve: 'CVE-2024-28219', pkg: 'Pillow', ver: '9.5.0', fixed: '10.3.0', severity: 'high', epss: '0.83', desc: 'Buffer overflow in TIFF image processing.' },
  { cve: 'CVE-2023-44428', pkg: 'cryptography', ver: '41.0.1', fixed: '41.0.6', severity: 'medium', epss: '0.44', desc: 'NULL pointer dereference in PKCS12 parsing.' },
  { cve: 'CVE-2024-26130', pkg: 'cryptography', ver: '41.0.1', fixed: '42.0.4', severity: 'high', epss: '0.77', desc: 'NULL pointer dereference in PKCS12 certificate decoding.' },
  { cve: 'CVE-2024-39689', pkg: 'certifi', ver: '2023.7.22', fixed: '2024.7.4', severity: 'medium', epss: '0.41', desc: 'Root CA bundle includes revoked certificates.' },
];

export const REMEDIATION_CHANGES = [
  { path: 'app/db/queries.py', reason: 'Replaced string concatenation with parameterized queries (CWE-89)' },
  { path: 'frontend/src/components/UserInput.tsx', reason: 'Replaced dangerouslySetInnerHTML with DOMPurify sanitization (CWE-79)' },
  { path: 'config/settings.py', reason: 'Moved credentials to environment variables (CWE-798)' },
  { path: 'app/routes/files.py', reason: 'Added path.resolve() + whitelist validation (CWE-22)' },
  { path: 'app/utils/cache.py', reason: 'Replaced pickle with json serialization (CWE-502)' },
  { path: 'requirements.txt', reason: 'Bumped requests?2.31.0, urllib3?2.0.7, Pillow?10.3.0, cryptography?42.0.4' },
];

export const ARCH_NODES: ArchNode[] = [
  { id: 'cf', type: 'CloudFront', x: 340, y: 40, color: '#06b6d4' },
  { id: 'alb', type: 'Application LB', x: 340, y: 130, color: '#8b5cf6' },
  { id: 'ec2a', type: 'EC2 (AZ-a)', x: 200, y: 230, color: '#22c55e' },
  { id: 'ec2b', type: 'EC2 (AZ-b)', x: 480, y: 230, color: '#22c55e' },
  { id: 'rds', type: 'RDS PostgreSQL', x: 340, y: 320, color: '#f59e0b' },
  { id: 's3', type: 'S3 Bucket', x: 560, y: 130, color: '#f59e0b' },
  { id: 'sg', type: 'Security Groups', x: 120, y: 130, color: '#6b7280' },
  { id: 'vpc', type: 'VPC / Subnets', x: 200, y: 320, color: '#6b7280' },
];

export const COST_BREAKDOWN: CostItem[] = [
  { service: 'CloudFront', type: 'CDN', monthly: 0.85, note: '50GB transfer/mo' },
  { service: 'Application Load Balancer', type: 'Networking', monthly: 18.4, note: '730 hrs + LCU' },
  { service: 'EC2 t3.micro × 2', type: 'Compute', monthly: 16.86, note: 'On-demand, us-east-1' },
  { service: 'RDS db.t3.micro', type: 'Database', monthly: 24.82, note: 'Single-AZ, 20GB gp3' },
  { service: 'S3 Standard', type: 'Storage', monthly: 2.3, note: '100GB + requests' },
  { service: 'Security Groups / VPC', type: 'Networking', monthly: 0, note: 'Included' },
  { service: 'CloudWatch Logs', type: 'Monitoring', monthly: 3.5, note: '5GB ingest/mo' },
];

export const TF_FILES: Record<string, string> = {
  'main.tf': `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

module "vpc" {
  source  = "./modules/vpc"
  cidr    = var.vpc_cidr
  project = var.project_name
}

module "compute" {
  source        = "./modules/compute"
  vpc_id        = module.vpc.vpc_id
  subnet_ids    = module.vpc.private_subnet_ids
  instance_type = var.instance_type
  project       = var.project_name
}

module "database" {
  source          = "./modules/database"
  vpc_id          = module.vpc.vpc_id
  subnet_ids      = module.vpc.private_subnet_ids
  instance_class  = var.db_instance_class
  project         = var.project_name
}

module "cdn" {
  source       = "./modules/cdn"
  alb_dns_name = module.compute.alb_dns_name
  project      = var.project_name
}`,
  'variables.tf': `variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "project_name" {
  type    = string
  default = "deplai-app"
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "instance_type" {
  type    = string
  default = "t3.micro"
}

variable "db_instance_class" {
  type    = string
  default = "db.t3.micro"
}

variable "environment" {
  type    = string
  default = "production"
}`,
  'outputs.tf': `output "cloudfront_url" {
  value       = module.cdn.cloudfront_url
  description = "CloudFront distribution URL"
}

output "alb_dns_name" {
  value       = module.compute.alb_dns_name
  description = "Application Load Balancer DNS name"
}

output "rds_endpoint" {
  value       = module.database.endpoint
  sensitive   = true
  description = "RDS instance endpoint"
}`,
  'modules/vpc/main.tf': `resource "aws_vpc" "main" {
  cidr_block           = var.cidr
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags = { Name = "\${var.project}-vpc" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.cidr, 8, count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]
}

resource "aws_security_group" "web" {
  name   = "\${var.project}-web-sg"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}`,
};

export const SEVERITY_CFG: Record<Severity, { bg: string; text: string; border: string; dot: string }> = {
  critical: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/25', dot: 'bg-red-500' },
  high: { bg: 'bg-orange-500/10', text: 'text-orange-400', border: 'border-orange-500/25', dot: 'bg-orange-500' },
  medium: { bg: 'bg-yellow-500/10', text: 'text-yellow-400', border: 'border-yellow-500/25', dot: 'bg-yellow-500' },
  low: { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/25', dot: 'bg-blue-500' },
};

export function withRuntimeStageStatus(scanStatus?: string): Stage[] {
  const stages = STAGES.map((stage) => ({ ...stage }));
  const scanStage = stages.find((stage) => stage.key === 'scan');
  const mergeStage = stages.find((stage) => stage.key === 'merge');

  if (scanStage) {
    if (scanStatus === 'running') {
      scanStage.status = 'running';
      scanStage.duration = 'In progress';
    } else if (scanStatus === 'found') {
      scanStage.status = 'success';
      scanStage.duration = 'Completed';
    } else if (scanStatus === 'not_found') {
      scanStage.status = 'success';
      scanStage.duration = 'No findings';
    } else {
      scanStage.status = 'pending';
      scanStage.duration = undefined;
    }
  }

  if (mergeStage) {
    mergeStage.status = scanStatus === 'found' ? 'active' : 'pending';
  }

  return stages;
}
