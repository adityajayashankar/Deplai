import fs from 'fs';
import path from 'path';

export type Provider = 'aws' | 'azure' | 'gcp';

const REPO_ROOT = path.resolve(process.cwd(), '..');
const LEGACY_ROOT = path.join(REPO_ROOT, 'DeplAI_old');
const LEGACY_AWS_ICONS_DIR = path.join(LEGACY_ROOT, 'AWS', 'pngs');
const LEGACY_AWS_MAPS_FILE = path.join(LEGACY_ROOT, 'AWS', 'constants', 'maps.py');
const LEGACY_CICD_DIR = path.join(LEGACY_ROOT, 'cicd_templates');
const LEGACY_TERRAFORM_RAG_ROOT = path.join(LEGACY_ROOT, 'terraform_rag_agent');

function safeReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function exists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

export function getLegacyAwsIconsDir(): string {
  return LEGACY_AWS_ICONS_DIR;
}

export function listLegacyAwsIconNames(): Set<string> {
  if (!exists(LEGACY_AWS_ICONS_DIR)) return new Set<string>();
  const names = fs
    .readdirSync(LEGACY_AWS_ICONS_DIR)
    .filter((entry) => entry.toLowerCase().endsWith('.png'))
    .map((entry) => entry.replace(/\.png$/i, '').toLowerCase());
  return new Set<string>(names);
}

export function loadLegacyAwsMapKeys(): string[] {
  const raw = safeReadFile(LEGACY_AWS_MAPS_FILE);
  if (!raw) return [];
  const keys = new Set<string>();
  const regex = /['"]([^'"]+)['"]\s*:/g;
  let match: RegExpExecArray | null = regex.exec(raw);
  while (match) {
    const key = String(match[1] || '').trim().toLowerCase();
    if (key) keys.add(key);
    match = regex.exec(raw);
  }
  return Array.from(keys).sort((a, b) => b.length - a.length);
}

export function readLegacyCicdTemplate(provider: Provider): string | null {
  const fileName = `${provider}_deploy_template.yml`;
  return safeReadFile(path.join(LEGACY_CICD_DIR, fileName));
}

export function getLegacyTerraformRagStatus() {
  const srcRoot = path.join(LEGACY_TERRAFORM_RAG_ROOT, 'src');
  const hasOrchestrator = exists(path.join(srcRoot, 'agent', 'orchestrator.py'));
  const hasDocs = exists(path.join(LEGACY_TERRAFORM_RAG_ROOT, 'README.md'));
  const hasVectorDb = exists(path.join(LEGACY_TERRAFORM_RAG_ROOT, 'data', 'vector_db'));
  return {
    available: hasOrchestrator || hasDocs || hasVectorDb,
    src_root: srcRoot,
    has_orchestrator: hasOrchestrator,
    has_docs: hasDocs,
    has_vector_db: hasVectorDb,
  };
}

export function getLegacyRootRuntimeStatus() {
  const requiredFiles = [
    'main.py',
    'streamlit_app.py',
    'docker-compose.yml',
    'README.md',
    'requirements.txt',
  ];
  const present = requiredFiles.filter((f) => exists(path.join(LEGACY_ROOT, f)));
  return {
    available: present.length > 0,
    required_count: requiredFiles.length,
    present_count: present.length,
    present_files: present,
  };
}
