import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { query } from '@/lib/db';
import { githubService } from '@/lib/github';
import { getLegacyRootRuntimeStatus, getLegacyTerraformRagStatus } from '@/lib/legacy-assets';
import fs from 'fs';
import path from 'path';

type Provider = 'aws' | 'azure' | 'gcp';

interface ScanResultsData {
  supply_chain?: Array<{ cve_id?: string; severity?: string; fix_version?: string }>;
  code_security?: Array<{ cwe_id?: string; severity?: string; count?: number }>;
}

interface IacGenerateBody {
  project_id: string;
  provider?: Provider;
  qa_summary?: string;
  architecture_context?: string;
  // Optional: full architecture JSON for RAG-based Terraform generation
  architecture_json?: Record<string, unknown>;
  // Optional: OpenAI key forwarded to the RAG agent
  openai_api_key?: string;
}

interface GeneratedFile {
  path: string;
  content: string;
  encoding?: 'utf-8' | 'base64';
}

interface ProjectMetaRow {
  project_type: 'local' | 'github';
  repo_full_name: string | null;
  installation_uuid: string | null;
}

const INDEX_HTML_CANDIDATES = [
  'index.html',
  'public/index.html',
  'src/index.html',
  'dist/index.html',
  'build/index.html',
];

interface WebsiteAsset {
  relativePath: string;
  contentBase64: string;
}

const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  '.next',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv',
]);

const SKIP_FILE_NAMES = new Set([
  '.ds_store',
  'thumbs.db',
]);

const MAX_SITE_FILES = 2500;
const MAX_SITE_FILE_BYTES = 8_000_000;
const MAX_SITE_TOTAL_BYTES = 20_000_000;

function defaultWebsiteHtml(projectName: string): string {
  return `<html>
  <head><title>DeplAI Deployment</title></head>
  <body style="font-family: Arial, sans-serif; padding: 2rem;">
    <h1>DeplAI deployment is live</h1>
    <p>Project: ${projectName}</p>
  </body>
</html>`;
}

function normalizeProjectPath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function normalizeWebsiteObjectKey(relPath: string): string {
  const normalized = normalizeProjectPath(relPath);
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return normalized;
  const leaf = String(parts[parts.length - 1] || '').toLowerCase();
  // Common typo in uploaded repos: index.html.html -> index.html
  if (leaf === 'index.html.html') {
    parts[parts.length - 1] = 'index.html';
    return parts.join('/');
  }
  return normalized;
}

function shouldSkipSourceEntry(relativePath: string, isDirectory: boolean): boolean {
  const normalized = normalizeProjectPath(relativePath);
  if (!normalized) return false;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.some(part => part === '.git')) return true;
  if (parts.some(part => SKIP_DIR_NAMES.has(part))) return true;

  const leaf = String(parts[parts.length - 1] || '').toLowerCase();
  if (!isDirectory && SKIP_FILE_NAMES.has(leaf)) return true;

  // Never mirror local secret files into public website assets.
  if (!isDirectory && (leaf === '.env' || leaf.startsWith('.env.'))) return true;
  return false;
}

function collectWebsiteAssets(rootPath: string): WebsiteAsset[] {
  const assets: WebsiteAsset[] = [];
  const pending: string[] = [''];
  let totalBytes = 0;

  while (pending.length > 0) {
    const relativeDir = pending.pop() || '';
    const absoluteDir = path.join(rootPath, ...relativeDir.split('/').filter(Boolean));

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const relativePath = normalizeProjectPath(relativeDir ? `${relativeDir}/${entry.name}` : entry.name);
      if (!relativePath) continue;
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (shouldSkipSourceEntry(relativePath, true)) continue;
        pending.push(relativePath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (shouldSkipSourceEntry(relativePath, false)) continue;

      const filePath = path.join(rootPath, ...relativePath.split('/'));
      const buffer = fs.readFileSync(filePath);

      if (buffer.length > MAX_SITE_FILE_BYTES) {
        throw new Error(`Project asset exceeds ${MAX_SITE_FILE_BYTES} bytes: ${relativePath}`);
      }

      totalBytes += buffer.length;
      if (totalBytes > MAX_SITE_TOTAL_BYTES) {
        throw new Error(`Project assets exceed ${MAX_SITE_TOTAL_BYTES} bytes; reduce bundle size before deployment.`);
      }

      assets.push({
        relativePath,
        contentBase64: buffer.toString('base64'),
      });

      if (assets.length > MAX_SITE_FILES) {
        throw new Error(`Project has more than ${MAX_SITE_FILES} files; reduce bundle size before deployment.`);
      }
    }
  }

  assets.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return assets;
}

function resolveIndexHtmlFromAssets(assets: WebsiteAsset[]): string | null {
  if (!assets.length) return null;
  const lookup = new Map<string, WebsiteAsset>();
  for (const asset of assets) {
    lookup.set(normalizeWebsiteObjectKey(asset.relativePath), asset);
  }

  for (const candidate of INDEX_HTML_CANDIDATES) {
    const hit = lookup.get(normalizeProjectPath(candidate));
    if (!hit) continue;
    const decoded = Buffer.from(hit.contentBase64, 'base64').toString('utf-8');
    if (decoded.trim()) return decoded;
  }

  return null;
}

async function resolveProjectSourceRoot(
  userId: string,
  projectId: string,
): Promise<string | null> {
  let rows = await query<ProjectMetaRow[]>(
    `SELECT
      p.project_type,
      gr.full_name AS repo_full_name,
      gi.id AS installation_uuid
    FROM projects p
    LEFT JOIN github_repositories gr ON p.repository_id = gr.id
    LEFT JOIN github_installations gi ON gr.installation_id = gi.id
    WHERE p.id = ?`,
    [projectId],
  );

  // For GitHub selections, the dashboard project id is usually github_repositories.id,
  // not projects.id. Fall back to resolving metadata directly from github_repositories.
  if (!rows[0]) {
    rows = await query<ProjectMetaRow[]>(
      `SELECT
        'github' AS project_type,
        gr.full_name AS repo_full_name,
        gi.id AS installation_uuid
      FROM github_repositories gr
      JOIN github_installations gi ON gr.installation_id = gi.id
      WHERE gr.id = ? AND gi.user_id = ?
      LIMIT 1`,
      [projectId, userId],
    );
  }

  const meta = rows[0];
  if (!meta) return null;

  if (meta.project_type === 'github' && meta.repo_full_name && meta.installation_uuid) {
    const [owner, repo] = meta.repo_full_name.split('/');
    if (owner && repo) {
      try {
        const repoRoot = await githubService.ensureRepoFresh(meta.installation_uuid, owner, repo);
        if (repoRoot && fs.existsSync(repoRoot) && fs.statSync(repoRoot).isDirectory()) {
          return repoRoot;
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  const localBase = path.join(process.cwd(), 'tmp', 'local-projects', userId, projectId);
  if (fs.existsSync(localBase) && fs.statSync(localBase).isDirectory()) {
    return localBase;
  }

  return null;
}

function clampProvider(value: string | undefined): Provider {
  const v = (value || '').trim().toLowerCase();
  if (v === 'azure' || v === 'gcp') return v;
  return 'aws';
}

function toAwsProjectSlug(value: string): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

  // Keep room for suffixes like "-security-logs-<8hex>" under S3's 63-char limit.
  const capped = normalized.slice(0, 40).replace(/-+$/, '');
  return capped || 'deplai-project';
}

function summarizeSecurity(data: ScanResultsData): {
  totalCodeFindings: number;
  totalSupplyFindings: number;
  criticalOrHighSupply: number;
  highCwe: string[];
} {
  const supply = Array.isArray(data.supply_chain) ? data.supply_chain : [];
  const code = Array.isArray(data.code_security) ? data.code_security : [];

  const totalCodeFindings = code.reduce((n, item) => n + Number(item.count || 0), 0);
  const totalSupplyFindings = supply.length;
  const criticalOrHighSupply = supply.filter(item => {
    const sev = String(item.severity || '').toLowerCase();
    return sev === 'critical' || sev === 'high';
  }).length;

  const highCwe = code
    .filter(item => {
      const sev = String(item.severity || '').toLowerCase();
      return sev === 'critical' || sev === 'high';
    })
    .map(item => String(item.cwe_id || '').trim())
    .filter(Boolean)
    .slice(0, 10);

  return { totalCodeFindings, totalSupplyFindings, criticalOrHighSupply, highCwe };
}

function buildWebsiteSiteFiles(siteAssets: WebsiteAsset[], siteIndexHtml: string): GeneratedFile[] {
  const byKey = new Map<string, WebsiteAsset>();
  for (const asset of siteAssets) {
    const key = normalizeWebsiteObjectKey(asset.relativePath);
    if (!key) continue;
    if (!byKey.has(key)) {
      byKey.set(key, { ...asset, relativePath: key });
    }
  }

  if (!byKey.has('index.html')) {
    byKey.set('index.html', {
      relativePath: 'index.html',
      contentBase64: Buffer.from(siteIndexHtml, 'utf-8').toString('base64'),
    });
  }

  return Array.from(byKey.values()).map(asset => ({
    path: `terraform/site/${normalizeProjectPath(asset.relativePath)}`,
    content: asset.contentBase64,
    encoding: 'base64',
  }));
}

function resolveWebsiteBlockPublicAccess(qaSummary: string, architectureContext: string): boolean {
  const qaText = String(qaSummary || '');
  const text = `${qaText}\n${architectureContext}`.toLowerCase();
  // Default secure posture with CloudFront OAC.
  if (!text.trim()) return true;

  // Prefer explicit Q/A parsing from stage-6 answers:
  // Q: ...Block Public Access...
  // A: yes/no/on/off
  const qaPairs = qaText.split(/\n\s*\n/g);
  for (const pair of qaPairs) {
    const question = (pair.match(/Q:\s*(.+)/i)?.[1] || '').toLowerCase();
    const answer = (pair.match(/A:\s*(.+)/i)?.[1] || '').toLowerCase();
    if (!question || !answer) continue;
    if (!question.includes('block public access')) continue;

    if (
      /\b(off|disable|disabled|no|false)\b/.test(answer) &&
      !/\b(on)\b/.test(answer)
    ) {
      return false;
    }
    if (
      /\b(on|enable|enabled|yes|true)\b/.test(answer) &&
      !/\b(off)\b/.test(answer)
    ) {
      return true;
    }
  }

  const explicitOff =
    text.includes('block public access off') ||
    text.includes('block public access: off') ||
    text.includes('disable block public access') ||
    text.includes('public access block off');
  if (explicitOff) return false;

  const explicitOn =
    text.includes('block public access on') ||
    text.includes('block public access: on') ||
    text.includes('enable block public access') ||
    text.includes('public access block on');
  if (explicitOn) return true;

  return true;
}

function buildAwsBundle(
  projectName: string,
  awsProjectSlug: string,
  contextBlock: string,
  sec: ReturnType<typeof summarizeSecurity>,
  siteAssets: WebsiteAsset[],
  siteIndexHtml: string,
  websiteBlockPublicAccess: boolean,
): GeneratedFile[] {
  const ec2HtmlBase64 = Buffer.from(siteIndexHtml, 'utf-8').toString('base64');
  const siteFiles = buildWebsiteSiteFiles(siteAssets, siteIndexHtml);

  const mainTf = `terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

resource "random_id" "suffix" {
  byte_length = 4
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default_in_vpc" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_security_group" "web" {
  name_prefix = "\${var.project_name}-web-"
  description = "Allow SSH and HTTP"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Project = var.project_name
    Managed = "deplai"
  }
}

data "aws_ami" "amazon_linux" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }
}

resource "aws_instance" "app" {
  count                       = var.enable_ec2 ? 1 : 0
  ami                         = data.aws_ami.amazon_linux.id
  instance_type               = var.instance_type
  subnet_id                   = tolist(data.aws_subnets.default_in_vpc.ids)[0]
  vpc_security_group_ids      = [aws_security_group.web.id]
  associate_public_ip_address = true

  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    iops                  = 3000
    encrypted             = false
    delete_on_termination = true
  }

  user_data = <<-EOT
    #!/bin/bash
    set -eux
    dnf update -y
    dnf install -y nginx
    systemctl enable nginx
    echo '${ec2HtmlBase64}' | base64 -d > /usr/share/nginx/html/index.html
    systemctl restart nginx
  EOT

  tags = {
    Name    = "\${var.project_name}-app"
    Project = var.project_name
    Managed = "deplai"
  }
}

resource "aws_s3_bucket" "security_logs" {
  bucket = "\${var.project_name}-security-logs-\${random_id.suffix.hex}"

  tags = {
    Project = var.project_name
    Managed = "deplai"
  }
}

resource "aws_s3_bucket_public_access_block" "security_logs" {
  bucket                  = aws_s3_bucket.security_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket" "website" {
  bucket = "\${var.project_name}-site-\${random_id.suffix.hex}"

  tags = {
    Project = var.project_name
    Managed = "deplai"
  }
}

resource "aws_s3_bucket_website_configuration" "website" {
  bucket = aws_s3_bucket.website.id

  index_document {
    suffix = "index.html"
  }

  error_document {
    key = "index.html"
  }
}

resource "aws_s3_bucket_public_access_block" "website" {
  bucket                  = aws_s3_bucket.website.id
  block_public_acls       = ${websiteBlockPublicAccess ? 'true' : 'false'}
  block_public_policy     = ${websiteBlockPublicAccess ? 'true' : 'false'}
  ignore_public_acls      = ${websiteBlockPublicAccess ? 'true' : 'false'}
  restrict_public_buckets = ${websiteBlockPublicAccess ? 'true' : 'false'}
}

locals {
  content_type_by_ext = {
    html = "text/html"
    htm  = "text/html"
    css  = "text/css"
    js   = "application/javascript"
    mjs  = "application/javascript"
    json = "application/json"
    map  = "application/json"
    txt  = "text/plain"
    xml  = "application/xml"
    svg  = "image/svg+xml"
    png  = "image/png"
    jpg  = "image/jpeg"
    jpeg = "image/jpeg"
    gif  = "image/gif"
    webp = "image/webp"
    ico  = "image/x-icon"
    woff = "font/woff"
    woff2 = "font/woff2"
    ttf  = "font/ttf"
    eot  = "application/vnd.ms-fontobject"
    otf  = "font/otf"
  }
}

resource "aws_s3_object" "website_assets" {
  for_each = fileset("\${path.module}/site", "**")
  bucket   = aws_s3_bucket.website.id
  key      = each.value
  source   = "\${path.module}/site/\${each.value}"
  etag     = filemd5("\${path.module}/site/\${each.value}")

  content_type = lookup(
    local.content_type_by_ext,
    lower(element(reverse(split(".", each.value)), 0)),
    "application/octet-stream",
  )
}

resource "aws_cloudfront_origin_access_control" "website" {
  name                              = "\${var.project_name}-oac-\${random_id.suffix.hex}"
  description                       = "Origin access control for S3 website bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "cdn" {
  enabled             = true
  wait_for_deployment = false
  default_root_object = "index.html"

  origin {
    domain_name              = aws_s3_bucket.website.bucket_regional_domain_name
    origin_id                = "s3-origin-\${aws_s3_bucket.website.id}"
    origin_access_control_id = aws_cloudfront_origin_access_control.website.id
  }

  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "s3-origin-\${aws_s3_bucket.website.id}"
    viewer_protocol_policy = "redirect-to-https"
    compress = true

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  depends_on = [aws_s3_object.website_assets]
}

data "aws_iam_policy_document" "website_oac" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["\${aws_s3_bucket.website.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.cdn.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "website" {
  bucket = aws_s3_bucket.website.id
  policy = data.aws_iam_policy_document.website_oac.json
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/deplai/\${var.project_name}-\${random_id.suffix.hex}"
  retention_in_days = 30
}

# Security context summary:
# - Code findings: ${sec.totalCodeFindings}
# - Supply findings: ${sec.totalSupplyFindings} (critical/high: ${sec.criticalOrHighSupply})
# - High-impact CWEs: ${sec.highCwe.join(', ') || 'none'}
# - Next: add workload modules and IAM least-privilege policies.
`;

  const varsTf = `variable "project_name" {
  type        = string
  description = "Project identifier for resource naming."
  default     = "${awsProjectSlug.replace(/"/g, '')}"
}

variable "aws_region" {
  type        = string
  description = "AWS region for deployment."
  default     = "ap-south-1"
}

variable "instance_type" {
  type        = string
  description = "EC2 instance size for the deployed workload."
  default     = "t3.micro"
}

variable "enable_ec2" {
  type        = bool
  description = "Whether to create EC2 workload resources."
  default     = true
}
`;

  const outputsTf = `output "security_logs_bucket" {
  value       = aws_s3_bucket.security_logs.bucket
  description = "Bucket for security and application logs."
}

output "app_log_group" {
  value       = aws_cloudwatch_log_group.app.name
  description = "CloudWatch log group for workloads."
}

output "instance_public_ip" {
  value       = try(aws_instance.app[0].public_ip, null)
  description = "Public IP for the deployed EC2 instance."
}

output "ec2_instance_id" {
  value       = try(aws_instance.app[0].id, null)
  description = "EC2 instance id."
}

output "ec2_instance_type" {
  value       = try(aws_instance.app[0].instance_type, null)
  description = "EC2 instance type."
}

output "ec2_ami_id" {
  value       = try(aws_instance.app[0].ami, null)
  description = "AMI id used for EC2."
}

output "ec2_public_dns" {
  value       = try(aws_instance.app[0].public_dns, null)
  description = "Public DNS name of EC2."
}

output "ec2_availability_zone" {
  value       = try(aws_instance.app[0].availability_zone, null)
  description = "Availability zone of EC2."
}

output "ec2_subnet_id" {
  value       = try(aws_instance.app[0].subnet_id, null)
  description = "Subnet id where EC2 is deployed."
}

output "ec2_vpc_security_group_ids" {
  value       = try(aws_instance.app[0].vpc_security_group_ids, [])
  description = "Security groups attached to EC2."
}

output "ec2_key_name" {
  value       = try(aws_instance.app[0].key_name, null)
  description = "EC2 key pair name if configured."
}

output "vpc_id" {
  value       = data.aws_vpc.default.id
  description = "Target VPC id."
}

output "subnet_ids" {
  value       = data.aws_subnets.default_in_vpc.ids
  description = "Candidate subnet ids in the VPC."
}

output "web_security_group_id" {
  value       = aws_security_group.web.id
  description = "Security group id for EC2 web ingress."
}

output "instance_url" {
  value       = try("http://\${aws_instance.app[0].public_ip}", null)
  description = "HTTP endpoint of the deployed instance."
}

output "website_bucket" {
  value       = aws_s3_bucket.website.bucket
  description = "S3 bucket hosting static assets for CloudFront."
}

output "cloudfront_domain_name" {
  value       = aws_cloudfront_distribution.cdn.domain_name
  description = "CloudFront domain name."
}

output "cloudfront_url" {
  value       = "https://\${aws_cloudfront_distribution.cdn.domain_name}"
  description = "Public CloudFront URL."
}

output "s3_website_endpoint" {
  value       = aws_s3_bucket_website_configuration.website.website_endpoint
  description = "S3 static website endpoint."
}
`;

  const ansiblePlaybook = `---
- name: Baseline security hardening
  hosts: all
  become: true
  tasks:
    - name: Ensure unattended upgrades package is present (Debian/Ubuntu)
      apt:
        name: unattended-upgrades
        state: present
      when: ansible_os_family == "Debian"

    - name: Disable root SSH login
      lineinfile:
        path: /etc/ssh/sshd_config
        regexp: '^#?PermitRootLogin'
        line: 'PermitRootLogin no'
      notify: restart ssh

    - name: Ensure UFW is enabled
      ufw:
        state: enabled
        policy: deny

  handlers:
    - name: restart ssh
      service:
        name: ssh
        state: restarted
`;

  const inventory = `[all]
# replace with your hosts
example-host ansible_host=127.0.0.1 ansible_user=ubuntu
`;

  const readme = `# IaC Bundle - ${projectName}

Generated by DeplAI pipeline Step 9.

## Included
- Terraform baseline for provider: AWS
- Ansible hardening playbook

## Context
${contextBlock}

## Commands
\`\`\`bash
terraform init
terraform plan
ansible-playbook -i ansible/inventory.ini ansible/playbooks/security-hardening.yml --syntax-check
\`\`\`
`;

  return [
    { path: 'terraform/main.tf', content: mainTf },
    { path: 'terraform/variables.tf', content: varsTf },
    { path: 'terraform/outputs.tf', content: outputsTf },
    ...siteFiles,
    { path: 'ansible/inventory.ini', content: inventory },
    { path: 'ansible/playbooks/security-hardening.yml', content: ansiblePlaybook },
    { path: 'README.md', content: readme },
  ];
}

function buildAzureBundle(projectName: string, contextBlock: string, sec: ReturnType<typeof summarizeSecurity>): GeneratedFile[] {
  const mainTf = `terraform {
  required_version = ">= 1.5.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "azurerm" {
  features {}
}

resource "random_id" "suffix" {
  byte_length = 4
}

resource "azurerm_resource_group" "main" {
  name     = "\${var.project_name}-rg-\${random_id.suffix.hex}"
  location = var.location
}

resource "azurerm_storage_account" "logs" {
  name                     = substr(replace("\${var.project_name}log\${random_id.suffix.hex}", "-", ""), 0, 24)
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}

# Security context summary:
# - Code findings: ${sec.totalCodeFindings}
# - Supply findings: ${sec.totalSupplyFindings} (critical/high: ${sec.criticalOrHighSupply})
# - High-impact CWEs: ${sec.highCwe.join(', ') || 'none'}
`;

  const varsTf = `variable "project_name" {
  type        = string
  default     = "${projectName.replace(/"/g, '')}"
  description = "Project identifier for resource naming."
}

variable "location" {
  type        = string
  default     = "centralindia"
  description = "Azure region."
}
`;

  const outputsTf = `output "resource_group_name" {
  value = azurerm_resource_group.main.name
}

output "storage_account_name" {
  value = azurerm_storage_account.logs.name
}
`;

  const ansiblePlaybook = `---
- name: Baseline security hardening
  hosts: all
  become: true
  tasks:
    - name: Ensure fail2ban is installed
      apt:
        name: fail2ban
        state: present
      when: ansible_os_family == "Debian"
`;

  const readme = `# IaC Bundle - ${projectName}

Generated by DeplAI pipeline Step 9.

## Included
- Terraform baseline for provider: Azure
- Ansible hardening playbook

## Context
${contextBlock}
`;

  return [
    { path: 'terraform/main.tf', content: mainTf },
    { path: 'terraform/variables.tf', content: varsTf },
    { path: 'terraform/outputs.tf', content: outputsTf },
    { path: 'ansible/playbooks/security-hardening.yml', content: ansiblePlaybook },
    { path: 'README.md', content: readme },
  ];
}

function buildGcpBundle(projectName: string, contextBlock: string, sec: ReturnType<typeof summarizeSecurity>): GeneratedFile[] {
  const mainTf = `terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_region
}

resource "random_id" "suffix" {
  byte_length = 4
}

resource "google_storage_bucket" "logs" {
  name     = "\${var.project_name}-logs-\${random_id.suffix.hex}"
  location = "ASIA-SOUTH1"
}

# Security context summary:
# - Code findings: ${sec.totalCodeFindings}
# - Supply findings: ${sec.totalSupplyFindings} (critical/high: ${sec.criticalOrHighSupply})
# - High-impact CWEs: ${sec.highCwe.join(', ') || 'none'}
`;

  const varsTf = `variable "project_name" {
  type    = string
  default = "${projectName.replace(/"/g, '')}"
}

variable "gcp_project_id" {
  type        = string
  description = "GCP project id"
}

variable "gcp_region" {
  type    = string
  default = "asia-south1"
}
`;

  const outputsTf = `output "logs_bucket_name" {
  value = google_storage_bucket.logs.name
}
`;

  const ansiblePlaybook = `---
- name: Baseline security hardening
  hosts: all
  become: true
  tasks:
    - name: Ensure auditd is installed
      package:
        name: auditd
        state: present
`;

  const readme = `# IaC Bundle - ${projectName}

Generated by DeplAI pipeline Step 9.

## Included
- Terraform baseline for provider: GCP
- Ansible hardening playbook

## Context
${contextBlock}
`;

  return [
    { path: 'terraform/main.tf', content: mainTf },
    { path: 'terraform/variables.tf', content: varsTf },
    { path: 'terraform/outputs.tf', content: outputsTf },
    { path: 'ansible/playbooks/security-hardening.yml', content: ansiblePlaybook },
    { path: 'README.md', content: readme },
  ];
}

export async function POST(req: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const body = await req.json() as IacGenerateBody;
    const projectId = String(body.project_id || '').trim();
    if (!projectId) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }

    const owned = await verifyProjectOwnership(user.id, projectId);
    if ('error' in owned) return owned.error;

    const provider = clampProvider(body.provider);
    const legacyTerraform = getLegacyTerraformRagStatus();
    const legacyRuntime = getLegacyRootRuntimeStatus();
    const projectName = String(owned.project?.name || owned.project?.full_name || projectId).split('/').pop() || projectId;
    const qa = String(body.qa_summary || '').trim();
    const arch = String(body.architecture_context || '').trim();
    const hasArchitectureJson = Boolean(
      body.architecture_json && Object.keys(body.architecture_json).length > 0,
    );

    // Hard gate: do not generate Terraform without any operator context.
    if (!qa && !arch && !hasArchitectureJson) {
      return NextResponse.json(
        {
          error: 'IaC generation requires Q/A context, architecture context, or architecture_json.',
          requires_context: true,
        },
        { status: 400 },
      );
    }

    let scanData: ScanResultsData = {};
    try {
      const scanRes = await fetch(`${AGENTIC_URL}/api/scan/results/${projectId}`, {
        headers: agenticHeaders(),
        signal: AbortSignal.timeout(30_000),
      });
      if (scanRes.ok) {
        const payload = await scanRes.json() as { data?: ScanResultsData };
        scanData = payload.data || {};
      }
    } catch {
      scanData = {};
    }

    const sec = summarizeSecurity(scanData);
    const contextBlock = [
      qa ? `Q/A Summary: ${qa}` : '',
      arch ? `Architecture Context: ${arch}` : '',
      `Code Findings: ${sec.totalCodeFindings}`,
      `Supply Findings: ${sec.totalSupplyFindings}`,
      `Critical/High Supply: ${sec.criticalOrHighSupply}`,
      `High-impact CWE IDs: ${sec.highCwe.join(', ') || 'none'}`,
    ].filter(Boolean).join('\n');

    const sourceRoot = provider === 'aws'
      ? await resolveProjectSourceRoot(String(user.id), projectId)
      : null;
    if (provider === 'aws' && !sourceRoot) {
      return NextResponse.json(
        {
          error: 'Could not resolve repository source files for AWS website packaging. Re-sync the project repository and retry.',
          requires_repo_sync: true,
        },
        { status: 400 },
      );
    }
    const websiteAssets = sourceRoot ? collectWebsiteAssets(sourceRoot) : [];
    if (provider === 'aws' && websiteAssets.length === 0) {
      return NextResponse.json(
        {
          error: 'Repository source was resolved but no deployable files were found for S3 website packaging.',
          requires_repo_sync: true,
        },
        { status: 400 },
      );
    }
    const resolvedIndexHtml = provider === 'aws' ? resolveIndexHtmlFromAssets(websiteAssets) : null;
    if (provider === 'aws' && !String(resolvedIndexHtml || '').trim()) {
      return NextResponse.json(
        {
          error: 'No deployable index.html found in repository (checked: index.html, public/index.html, src/index.html, dist/index.html, build/index.html).',
          requires_repo_sync: true,
        },
        { status: 400 },
      );
    }
    const websiteIndexHtml = provider === 'aws'
      ? String(resolvedIndexHtml || '').trim()
      : ((resolvedIndexHtml || '').trim() || defaultWebsiteHtml(projectName));
    const awsProjectSlug = toAwsProjectSlug(projectName);
    const websiteBlockPublicAccess = resolveWebsiteBlockPublicAccess(qa, arch);

    // Keep AWS generation deterministic so runtime deploy always includes EC2+S3+CloudFront
    // and repository file mirroring behavior remains consistent.
    if (hasArchitectureJson && provider !== 'aws') {
      try {
        const ragRes = await fetch(`${AGENTIC_URL}/api/terraform/generate`, {
          method: 'POST',
          headers: { ...agenticHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            architecture_json: body.architecture_json,
            provider,
            project_name: projectName,
            qa_summary: qa || null,
            openai_api_key: body.openai_api_key || null,
          }),
          signal: AbortSignal.timeout(300_000),
        });
        const ragData = await ragRes.json() as {
          success: boolean; source?: string; files?: GeneratedFile[];
          readme?: string; error?: string;
        };

        if (ragData.success && ragData.source === 'rag_agent' && Array.isArray(ragData.files)) {
          return NextResponse.json({
            success: true,
            provider,
            project_id: projectId,
            project_name: projectName,
            summary: `Generated ${ragData.files.length} IaC files via Terraform RAG agent.`,
            files: ragData.files,
            security_context: sec,
            source: 'rag_agent',
            legacy_assets: {
              terraform_rag: legacyTerraform,
              runtime_reference: legacyRuntime,
            },
          });
        }
        // source === 'unavailable' or other failure -> fall through to templates
      } catch {
        // RAG agent unreachable -> fall through
      }
    }

    // Template fallback
    const files = provider === 'azure'
      ? buildAzureBundle(projectName, contextBlock, sec)
      : provider === 'gcp'
        ? buildGcpBundle(projectName, contextBlock, sec)
        : buildAwsBundle(
          projectName,
          awsProjectSlug,
          contextBlock,
          sec,
          websiteAssets,
          websiteIndexHtml,
          websiteBlockPublicAccess,
        );

    return NextResponse.json({
      success: true,
      provider,
      project_id: projectId,
      project_name: projectName,
      summary: `Generated ${files.length} IaC files for ${provider.toUpperCase()}.`,
      files,
      security_context: sec,
      source: 'template',
      legacy_assets: {
        terraform_rag: legacyTerraform,
        runtime_reference: legacyRuntime,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to generate IaC bundle';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
