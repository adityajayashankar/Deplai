import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { dump } from 'js-yaml';
import { assertIdentifier } from './contracts';
import { type ImportFile } from './ingestion';
import { profileRepository } from './profiler';
import { validateArtifact } from './artifacts';
import { type ArtifactBundle } from './artifact-schemas';
import { type COMMAND_CLASSES } from './runtime-schema';

type Classification = typeof COMMAND_CLASSES[number];
type Runtime = ArtifactBundle['runtime.yaml'];
type Inference = NonNullable<Runtime['inference']>;
export function classifyCommand(body: string, requiresSecret = false, metadataOnly = false): Classification[] {
  if (metadataOnly) return ['SAFE_METADATA'];
  const classes: Classification[] = ['REQUIRES_SANDBOX'];
  if (/\b(?:install|ci|add|fetch|curl|wget|npx|dlx)\b/.test(body)) classes.push('REQUIRES_NETWORK');
  if (requiresSecret || /(?:\$\{?|%)(?:[A-Z_]*(?:SECRET|TOKEN|PASSWORD|KEY|DATABASE_URL))/.test(body)) classes.push('REQUIRES_SECRET');
  if (/[;&|`<>\r\n]|\$\(|\b(?:sudo|docker|mount|umount|chroot|nsenter|rm|mkfs|reboot|shutdown)\b|(?:\/var\/run|169\.254\.169\.254)/i.test(body)) classes.push('UNSAFE');
  return classes;
}

/** Stable Kahn ordering; unknown references and cycles are errors, never silently dropped. */
export function startupOrder(nodes: { id: string; dependencies: string[] }[]): string[] {
  const remaining = new Map(nodes.map(n => [n.id, new Set(n.dependencies)]));
  if (remaining.size !== nodes.length || nodes.some(n => n.dependencies.some(d => !remaining.has(d)))) throw new Error('Invalid startup graph references');
  const result: string[] = [];
  while (remaining.size) {
    const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([id]) => id).sort();
    if (!ready.length) throw new Error('Runtime startup dependency cycle');
    for (const id of ready) { remaining.delete(id); result.push(id); for (const deps of remaining.values()) deps.delete(id); }
  }
  return result;
}

/** Metadata inference only. Never executes scripts, imports modules, or writes source. */
export function inferRuntime(input: { source_revision: string; worktree_id: string; expected_content_sha256: string; files: ImportFile[] }) {
  assertIdentifier(input.worktree_id);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.source_revision)) throw new Error('Exact runtime revision required');
  const profile = profileRepository(input.files);
  if (profile.content_sha256 !== input.expected_content_sha256) throw new Error('Runtime source fingerprint mismatch');
  const files = [...input.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const paths = new Set(files.map(f => f.path));
  const services: Runtime['services'] = []; const resources: Runtime['resources'] = [];
  const inference: Inference = { content_sha256: profile.content_sha256, commands: [], environment: [], boot_steps: [], boot_order: [], evidence: [], blockers: [], launch_authorized: false };
  const manifests = files.filter(f => /(?:^|\/)(?:package\.json|requirements\.txt)$/.test(f.path));
  if (manifests.length > 64) throw new Error('Runtime manifest limit exceeded; analyze a smaller scoped workspace');
  const directories = [...new Set(manifests.map(f => posix.dirname(f.path)))];
  const owner = (path: string) => directories.filter(d => d === '.' || path.startsWith(d + '/')).sort((a, b) => b.length - a.length)[0];
  const ownedFiles = new Map<string, ImportFile[]>();
  for (const file of files) {
    const directory = owner(file.path);
    if (directory !== undefined) { if (!ownedFiles.has(directory)) ownedFiles.set(directory, []); ownedFiles.get(directory)!.push(file); }
  }
  for (const file of manifests) {
    const directory = posix.dirname(file.path);
    const serviceId = 'svc-' + createHash('sha256').update(file.path).digest('hex').slice(0, 12);
    const source = file.bytes.length <= 256 * 1024 ? file.bytes.toString('utf8') : '';
    const node = file.path.endsWith('package.json');
    let deps: Record<string, unknown> = {}; let scripts: Record<string, unknown> = {};
    if (node) {
      try {
        const manifest = JSON.parse(source);
        deps = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) }; scripts = manifest.scripts || {};
        if (typeof scripts !== 'object' || Array.isArray(scripts)) throw new Error();
      } catch { inference.blockers.push(`${serviceId}: manifest could not be interpreted`); continue; }
    }
    const has = (name: string) => node ? Object.hasOwn(deps, name) : new RegExp(`^\\s*${name}(?:\\[|[=<>~!;\\s]|$)`, 'mi').test(source);
    const framework = has('next') ? 'Next.js' : has('vite') ? 'Vite' : has('@nestjs/core') ? 'NestJS' : has('express') ? 'Express' : has('fastapi') ? 'FastAPI' : has('django') ? 'Django' : 'UNKNOWN';
    const frontend = ['Next.js', 'Vite'].includes(framework);
    const local = (name: string) => directory === '.' ? name : `${directory}/${name}`;
    const ancestor = (name: string) => { let dir = directory; for (;;) { if (paths.has(dir === '.' ? name : `${dir}/${name}`)) return true; if (dir === '.') return false; dir = posix.dirname(dir); } };
    const manager = ancestor('pnpm-lock.yaml') ? 'pnpm' : ancestor('yarn.lock') ? 'yarn' : ancestor('bun.lock') || ancestor('bun.lockb') ? 'bun' : 'npm';
    const service: Runtime['services'][number] = { id: serviceId, type: frontend ? 'frontend' : 'backend', framework, directory,
      install: node ? manager === 'npm' ? ['npm', ancestor('package-lock.json') ? 'ci' : 'install'] : [manager, 'install'] : ['python', '-m', 'pip', 'install', '-r', 'requirements.txt'],
      dev: null, build: null, production: null, port: null, public: frontend, dependencies: [], health_check: null, required_environment_keys: [], secret_references: [] };
    // Workspace installs must run at the lockfile owner, not an invented package root.
    if (node && !['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].some(n => paths.has(local(n))) && ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].some(ancestor)) {
      service.install = null; inference.blockers.push(`${serviceId}: workspace install requires reviewed root configuration`);
    }
    for (const [kind, script] of [['dev', 'dev'], ['build', 'build'], ['production', 'start'], ['migration', Object.hasOwn(scripts, 'db:migrate') ? 'db:migrate' : 'migrate']] as const) {
      if (node && typeof scripts[script] === 'string') {
        const argv = [manager, 'run', script]; const classifications = classifyCommand(scripts[script] as string);
        inference.commands.push({ service_id: serviceId, kind, argv, classifications, evidence_path: file.path });
        if (classifications.includes('UNSAFE')) inference.blockers.push(`${serviceId}: ${kind} command needs security review`);
        else if (kind !== 'migration') service[kind] = [...argv];
      }
    }
    if (!node && framework === 'FastAPI') {
      const entry = (ownedFiles.get(directory) || []).slice(0, 256).find(f => /(?:^|\/)(?:main|app)\.py$/.test(f.path) && f.bytes.length <= 256 * 1024 && /^app\s*=\s*FastAPI\(/m.test(f.bytes.toString('utf8')));
      if (entry) {
        const moduleName = posix.relative(directory, entry.path).replace(/\.py$/, '').replaceAll('/', '.');
        if (/^[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*$/.test(moduleName)) {
          service.dev = ['python', '-m', 'uvicorn', `${moduleName}:app`, '--host', '0.0.0.0', '--port', '8000']; service.port = 8000;
          inference.commands.push({ service_id: serviceId, kind: 'dev', argv: [...service.dev], classifications: ['REQUIRES_SANDBOX'], evidence_path: entry.path });
          inference.evidence.push({ service_id: serviceId, field: 'entrypoint', path: entry.path, confidence: 0.8 });
          const health = entry.bytes.toString('utf8').match(/@app\.get\(["'](\/(?:health|healthz|api\/health))["']\)/);
          if (health) service.health_check = { type: 'http', path: health[1], port: 8000, timeout_seconds: 10 };
        }
      }
    }
    if (frontend) {
      const command = typeof scripts.dev === 'string' ? scripts.dev : '';
      const explicit = command.match(/(?:--port(?:=|\s+)|-p\s+)(\d{1,5})\b/);
      service.port = explicit ? +explicit[1] : framework === 'Next.js' ? 3000 : 5173;
      inference.evidence.push({ service_id: serviceId, field: explicit ? 'configured_port' : 'conventional_port_requires_confirmation', path: file.path, confidence: explicit ? 0.9 : 0.6 });
    }
    if (node) {
      for (const candidate of (ownedFiles.get(directory) || []).slice(0, 256).filter(f => /\.(?:[cm]?js|ts)$/.test(f.path) && f.bytes.length <= 256 * 1024)) {
        const text = candidate.bytes.toString('utf8');
        const port = text.match(/\b(?:app|server)\.listen\(\s*(\d{1,5})\b/);
        if (port && !service.port) {
          service.port = +port[1]; inference.evidence.push({ service_id: serviceId, field: 'listening_port', path: candidate.path, confidence: 0.8 });
        }
        const endpoint = text.match(/\b(?:app|router)\.get\(\s*["'](\/(?:health|healthz|api\/health))["']/);
        if (endpoint && service.port) service.health_check = { type: 'http', path: endpoint[1], port: service.port, timeout_seconds: 10 };
      }
    }
    for (const [names, type, technology] of [[['pg', 'psycopg', 'psycopg2', 'psycopg2-binary'], 'postgres', 'PostgreSQL'], [['redis', 'ioredis'], 'redis', 'Redis'], [['mongodb', 'pymongo', 'mongoose'], 'mongodb', 'MongoDB']] as const) {
      if (names.some(has)) {
        const id = `${serviceId}-${type}`; resources.push({ id, type, technology, dependencies: [], secret_references: [] }); service.dependencies.push(id);
        inference.blockers.push(`${id}: resource inferred from client dependency; confirm preview instance and bind secret references`);
      }
    }
    const keys = profile.detections.environment_keys.filter(e => e.source_path && owner(e.source_path) === directory);
    for (const key of [...new Set(keys.map(e => e.value))].sort()) {
      const internal = /(?:DATABASE|REDIS|MONGO|API|BACKEND|FRONTEND|SERVICE|QUEUE|BROKER)_(?:URL|URI|HOST)$/.test(key) || /^(?:DATABASE_URL|MONGODB_URI|REDIS_URL)$/.test(key);
      const generated = /(?:SESSION_SECRET|JWT_SECRET|COOKIE_SECRET)$/.test(key);
      const secret = /(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)$/.test(key);
      const optional = /^(?:NODE_ENV|PORT|LOG_LEVEL|DEBUG)$/.test(key);
      const kind = internal ? 'INTERNAL_SERVICE_URL' : generated ? 'GENERATED_PREVIEW' : secret ? 'USER_PROVIDED_SECRET' : 'OPTIONAL_SETTING';
      if (!optional) service.required_environment_keys.push(key);
      inference.environment.push({ service_id: serviceId, key, kind, evidence_paths: [...new Set(keys.filter(e => e.value === key).map(e => e.source_path!))], required: !optional, review_required: !optional });
      if (!optional) inference.blockers.push(`${serviceId}: review environment binding ${key}`);
    }
    const needsSecret = inference.environment.some(e => e.service_id === serviceId && ['GENERATED_PREVIEW', 'USER_PROVIDED_SECRET', 'INTERNAL_SERVICE_URL'].includes(e.kind));
    if (needsSecret) for (const command of inference.commands.filter(c => c.service_id === serviceId && c.kind !== 'build')) if (!command.classifications.includes('REQUIRES_SECRET')) command.classifications.push('REQUIRES_SECRET');
    if (service.install) inference.commands.push({ service_id: serviceId, kind: 'install', argv: [...service.install], classifications: ['REQUIRES_SANDBOX', 'REQUIRES_NETWORK'], evidence_path: file.path });
    if (!service.dev) inference.blockers.push(`${serviceId}: no supported development command`);
    if ((ownedFiles.get(directory)?.length || 0) > 256) inference.blockers.push(`${serviceId}: runtime source evidence limited to 256 files`);
    if (frontend) inference.blockers.push(`${serviceId}: confirm development bind interface and public preview routing`);
    if (!service.health_check) inference.blockers.push(`${serviceId}: health check unknown`);
    if (service.port === null) inference.blockers.push(`${serviceId}: listening port unknown`);
    inference.evidence.push({ service_id: serviceId, field: 'framework', path: file.path, confidence: framework === 'UNKNOWN' ? 0 : 0.9 });
    services.push(service);
  }
  if (!services.length) throw new Error('No supported runtime manifests; explicit review required');
  for (const resource of resources) inference.boot_steps.push({ id: resource.id, kind: 'resource', target: resource.id, dependencies: [] });
  for (const service of services) {
    const install = inference.commands.find(c => c.service_id === service.id && c.kind === 'install');
    const migration = inference.commands.find(c => c.service_id === service.id && c.kind === 'migration' && !c.classifications.includes('UNSAFE'));
    const installId = `${service.id}-install`; const migrationId = `${service.id}-migration`;
    if (install) inference.boot_steps.push({ id: installId, kind: 'install', target: service.id, dependencies: [] });
    const prerequisites = [...service.dependencies, ...(install ? [installId] : [])];
    if (migration) inference.boot_steps.push({ id: migrationId, kind: 'migration', target: service.id, dependencies: prerequisites });
    inference.boot_steps.push({ id: service.id, kind: 'service', target: service.id, dependencies: migration ? [migrationId] : prerequisites });
  }
  inference.boot_order = startupOrder(inference.boot_steps);
  inference.blockers.push('Cross-service URLs and startup relationships require review; dependency clients do not prove connectivity');
  if (services.filter(s => s.public).length > 1) inference.blockers.push('Multiple frontends require explicit preview path routing');
  if (profile.skipped.length) inference.blockers.push('Profiler omitted oversized or over-budget evidence');
  const runtime = validateArtifact('runtime.yaml', { schema_version: 1, source_revision: input.source_revision, worktree_id: input.worktree_id, services, resources,
    routes: services.filter(s => s.public).length === 1 ? [{ path: '/', target: services.find(s => s.public)!.id }] : [], inference });
  return { artifact_path: '.deplai/runtime.yaml' as const, runtime, yaml: dump(runtime, { noRefs: true, lineWidth: 100 }) };
}
