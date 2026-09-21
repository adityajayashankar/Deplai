import { createHash } from 'node:crypto';
import { repositoryMap, safeImportPath, type ImportFile } from './ingestion';

export const PROFILE_CATEGORIES = ['languages', 'frameworks', 'package_managers', 'monorepo_systems', 'build_tools', 'test_frameworks', 'orms', 'migration_frameworks', 'db_clients', 'queue_libraries', 'worker_frameworks', 'realtime_libraries', 'storage_sdks', 'docker_configuration', 'ci_configuration', 'entrypoints', 'probable_commands', 'probable_ports', 'environment_keys'] as const;
type Category = typeof PROFILE_CATEGORIES[number];
export type Detection = { value: string; confidence: number; source_path: string | null; pattern: string };
export type RepositoryProfile = { schema_version: 1; content_sha256: string; detections: Record<Category, Detection[]>; skipped: Array<{ source_path: string; reason: string }> };
const rules: Record<string, [Category, string][]> = {
  next: [['frameworks', 'Next.js']], react: [['frameworks', 'React']], vue: [['frameworks', 'Vue']], svelte: [['frameworks', 'Svelte']], express: [['frameworks', 'Express']], '@nestjs/core': [['frameworks', 'NestJS']], fastapi: [['frameworks', 'FastAPI']], django: [['frameworks', 'Django']], flask: [['frameworks', 'Flask']],
  vite: [['build_tools', 'Vite']], webpack: [['build_tools', 'webpack']], typescript: [['languages', 'TypeScript']], turbo: [['monorepo_systems', 'Turborepo']], nx: [['monorepo_systems', 'Nx']],
  jest: [['test_frameworks', 'Jest']], vitest: [['test_frameworks', 'Vitest']], '@playwright/test': [['test_frameworks', 'Playwright']], pytest: [['test_frameworks', 'pytest']],
  prisma: [['orms', 'Prisma'], ['migration_frameworks', 'Prisma Migrate']], '@prisma/client': [['orms', 'Prisma']], 'drizzle-orm': [['orms', 'Drizzle']], 'drizzle-kit': [['migration_frameworks', 'Drizzle Kit']], sqlalchemy: [['orms', 'SQLAlchemy']], alembic: [['migration_frameworks', 'Alembic']], typeorm: [['orms', 'TypeORM']], sequelize: [['orms', 'Sequelize']],
  pg: [['db_clients', 'PostgreSQL']], psycopg: [['db_clients', 'PostgreSQL']], psycopg2: [['db_clients', 'PostgreSQL']], 'psycopg2-binary': [['db_clients', 'PostgreSQL']], mysql2: [['db_clients', 'MySQL']], pymongo: [['db_clients', 'MongoDB']], mongodb: [['db_clients', 'MongoDB']], mongoose: [['orms', 'Mongoose'], ['db_clients', 'MongoDB']], redis: [['db_clients', 'Redis']], ioredis: [['db_clients', 'Redis']],
  bullmq: [['queue_libraries', 'BullMQ'], ['worker_frameworks', 'BullMQ']], bull: [['queue_libraries', 'Bull']], celery: [['worker_frameworks', 'Celery']], rq: [['worker_frameworks', 'RQ']], amqplib: [['queue_libraries', 'AMQP']], pika: [['queue_libraries', 'AMQP']], kafkajs: [['queue_libraries', 'KafkaJS']],
  'socket.io': [['realtime_libraries', 'Socket.IO']], ws: [['realtime_libraries', 'ws']], channels: [['realtime_libraries', 'Django Channels']],
  '@aws-sdk/client-s3': [['storage_sdks', 'AWS S3 SDK']], boto3: [['storage_sdks', 'AWS SDK (boto3)']], '@google-cloud/storage': [['storage_sdks', 'Google Cloud Storage']], '@azure/storage-blob': [['storage_sdks', 'Azure Blob Storage']],
};
const extensions: Record<string, string> = { ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', rb: 'Ruby', php: 'PHP', cs: 'C#', css: 'CSS', html: 'HTML', vue: 'Vue', svelte: 'Svelte' };
const manifests: Record<string, [Category, string][]> = {
  'pnpm-lock.yaml': [['package_managers', 'pnpm']], 'pnpm-workspace.yaml': [['monorepo_systems', 'pnpm workspaces'], ['package_managers', 'pnpm']], 'yarn.lock': [['package_managers', 'Yarn']], 'package-lock.json': [['package_managers', 'npm']], 'bun.lock': [['package_managers', 'Bun']], 'bun.lockb': [['package_managers', 'Bun']],
  'turbo.json': [['monorepo_systems', 'Turborepo']], 'nx.json': [['monorepo_systems', 'Nx']], 'requirements.txt': [['package_managers', 'pip']], 'poetry.lock': [['package_managers', 'Poetry']], 'Pipfile': [['package_managers', 'Pipenv']], 'uv.lock': [['package_managers', 'uv']],
  'schema.prisma': [['orms', 'Prisma']], 'alembic.ini': [['migration_frameworks', 'Alembic']], 'manage.py': [['frameworks', 'Django']], 'pom.xml': [['build_tools', 'Maven'], ['languages', 'Java']], 'build.gradle': [['build_tools', 'Gradle']], 'build.gradle.kts': [['build_tools', 'Gradle']], 'Cargo.toml': [['package_managers', 'Cargo'], ['languages', 'Rust']], 'go.mod': [['package_managers', 'Go modules']],
};

/** Read-only deterministic profiler. Findings are evidence, never architecture or launch approval. */
export function profileRepository(files: ImportFile[]): RepositoryProfile {
  repositoryMap(files); // Reuse file/path/count/total-byte and credential-file validation.
  const detections = Object.fromEntries(PROFILE_CATEGORIES.map(c => [c, []])) as unknown as Record<Category, Detection[]>;
  const skipped: RepositoryProfile['skipped'] = []; const seen = new Set<string>(); const hash = createHash('sha256');
  const filePaths = new Set(files.map(file => file.path));
  const cappedSources = new Set<string>();
  const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  function emit(category: Category, value: string, source: string, pattern: string, confidence = 1) {
    if (seen.size >= 20000) {
      if (!cappedSources.has(source)) { cappedSources.add(source); skipped.push({ source_path: source, reason: 'Profile detection limit reached; further evidence omitted' }); }
      return;
    }
    const detection = { value, confidence, source_path: source, pattern }; const key = JSON.stringify([category, detection]);
    if (!seen.has(key)) { seen.add(key); detections[category].push(detection); }
  }
  for (const file of sorted) {
    const name = file.path; const base = name.split('/').at(-1)!;
    hash.update(JSON.stringify([name, file.executable, createHash('sha256').update(file.bytes).digest('hex')]));
    const ext = base.split('.').at(-1)!;
    if (Object.hasOwn(extensions, ext)) emit('languages', extensions[ext], name, `extension:.${ext}`, 0.9);
    for (const [category, value] of Object.hasOwn(manifests, base) ? manifests[base] : []) emit(category, value, name, 'filename', base === 'manage.py' ? 0.7 : 0.95);
    if (/^drizzle\.config\./.test(base)) emit('orms', 'Drizzle', name, 'filename', 0.9);
    if (/^Dockerfile(?:\.|$)/i.test(base)) emit('docker_configuration', 'Dockerfile', name, 'filename');
    if (/^(?:docker-compose|compose)(?:[.-].*)?\.ya?ml$/i.test(base)) emit('docker_configuration', 'Docker Compose', name, 'filename');
    if (name.startsWith('.github/workflows/') && /\.ya?ml$/.test(base)) emit('ci_configuration', 'GitHub Actions', name, 'workflow path');
    if (base === '.gitlab-ci.yml') emit('ci_configuration', 'GitLab CI', name, 'filename');
    if (base === 'Jenkinsfile') emit('ci_configuration', 'Jenkins', name, 'filename');
    if (/^(main|index|server|app)\.(ts|js|mjs|py|go|rs)$/.test(base) || base === 'manage.py' || base === 'Procfile') emit('entrypoints', name, name, 'conventional entrypoint filename', 0.6);
    if (file.bytes.length > 256 * 1024) { skipped.push({ source_path: name, reason: 'Content scan exceeds 256 KiB; filename evidence only' }); continue; }
    if (file.bytes.includes(0)) { skipped.push({ source_path: name, reason: 'Binary content; filename evidence only' }); continue; }
    const text = file.bytes.toString('utf8');
    if (base === 'package.json') {
      try {
        const pkg = JSON.parse(text);
        if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error();
        for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
          if (!pkg[section] || typeof pkg[section] !== 'object' || Array.isArray(pkg[section])) continue;
          for (const dependency of Object.keys(pkg[section]).sort()) for (const [category, value] of Object.hasOwn(rules, dependency) ? rules[dependency] : []) emit(category, value, name, `${section}.${dependency}`);
        }
        if (pkg.workspaces && (Array.isArray(pkg.workspaces) || typeof pkg.workspaces === 'object')) emit('monorepo_systems', 'Package workspaces', name, 'workspaces');
        let manager = typeof pkg.packageManager === 'string' ? /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager)?.[1] : undefined;
        if (manager) emit('package_managers', manager, name, 'packageManager');
        if (!manager) {
          const directoryParts = name.split('/').slice(0, -1);
          for (let depth = directoryParts.length; depth >= 0 && !manager; depth--) {
            const prefix = directoryParts.slice(0, depth).join('/');
            const candidates = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm'], ['bun.lock', 'bun'], ['bun.lockb', 'bun']];
            const found = candidates.filter(([lock]) => filePaths.has(prefix ? `${prefix}/${lock}` : lock));
            if (found.length === 1) manager = found[0][1];
            if (found.length > 1) break; // Conflicting lockfiles do not establish one manager.
          }
        }
        for (const key of ['dev', 'start', 'build', 'test', 'preview']) if (typeof pkg.scripts?.[key] === 'string') {
          // Emit only an invocation hint, never arbitrary script text or inline credentials.
          emit('probable_commands', `${manager || 'npm'} run ${key}`, name, `scripts.${key}`, manager ? 0.95 : 0.6);
          for (const match of pkg.scripts[key].matchAll(/(?:--port(?:=|\s+)|-p\s+|PORT=)(\d{1,5})\b/g)) { const port = Number(match[1]); if (port > 0 && port <= 65535) emit('probable_ports', String(port), name, `scripts.${key}:port option`, 0.8); }
        }
        if (typeof pkg.main === 'string') { try { safeImportPath(pkg.main); emit('entrypoints', pkg.main, name, 'main'); } catch { skipped.push({ source_path: name, reason: 'Unsafe main path ignored' }); } }
      } catch { skipped.push({ source_path: name, reason: 'Malformed package manifest; filename evidence only' }); }
    }
    if (/^(?:requirements.*\.txt|pyproject.toml|Pipfile)$/.test(base)) {
      const lines = text.split(/\r?\n/).filter(line => !line.trim().startsWith('#'));
      for (const dependency of Object.keys(rules).filter(key => /^[a-z0-9-]+$/.test(key)).sort()) {
        const pattern = new RegExp(`(?:^|["'])${dependency}(?:["'\\s=<>!~\\[]|$)`, 'i');
        if (lines.some(line => pattern.test(line.trim()))) for (const [category, value] of rules[dependency]) emit(category, value, name, `dependency token:${dependency}`, base.startsWith('requirements') ? 0.95 : 0.7);
      }
      if (/^\[tool\.poetry(?:\.|\])/m.test(text)) emit('package_managers', 'Poetry', name, '[tool.poetry]');
      if (/^\[tool\.uv(?:\.|\])/m.test(text)) emit('package_managers', 'uv', name, '[tool.uv]');
      if (/^\[workspace\]/m.test(text)) emit('monorepo_systems', 'Workspace manifest', name, '[workspace]', 0.7);
    }
    if (base === 'Cargo.toml' && /^\[workspace\]/m.test(text)) emit('monorepo_systems', 'Cargo workspace', name, '[workspace]');
    if (base === 'pom.xml' && /<artifactId>\s*spring-boot(?:-[a-z-]+)?\s*<\/artifactId>/.test(text)) emit('frameworks', 'Spring Boot', name, 'Maven spring-boot artifact', 0.9);
    if (/^build\.gradle(?:\.kts)?$/.test(base) && /["']org\.springframework\.boot["']/.test(text)) emit('frameworks', 'Spring Boot', name, 'Gradle Spring Boot plugin', 0.9);
    if (base === 'Cargo.toml') for (const dependency of ['axum', 'actix-web', 'rocket', 'diesel', 'sqlx', 'tokio']) {
      if (new RegExp(`^\\s*${dependency}\\s*=`, 'm').test(text)) emit(['diesel', 'sqlx'].includes(dependency) ? 'db_clients' : 'frameworks', dependency, name, `Cargo dependency:${dependency}`, 0.8);
    }
    if (/^Dockerfile(?:\.|$)/i.test(base)) {
      for (const match of text.matchAll(/^\s*EXPOSE\s+(\d{1,5})(?:\/tcp|\/udp)?\s*$/gm)) if (+match[1] > 0 && +match[1] <= 65535) emit('probable_ports', match[1], name, 'EXPOSE', 0.95);
      for (const keyword of ['ENTRYPOINT', 'CMD']) if (new RegExp(`^\\s*${keyword}\\s+`, 'm').test(text)) emit('entrypoints', `Docker ${keyword}`, name, keyword, 0.9);
    }
    // Keys only; no literal values, command bodies, URLs or source snippets leave this function.
    const patterns = [/(?:process\.env\.|import\.meta\.env\.)([A-Z][A-Z0-9_]{0,127})\b/g, /(?:process\.env|os\.environ)\s*\[\s*["']([A-Z][A-Z0-9_]{0,127})["']\s*\]/g, /(?:os\.getenv|os\.environ\.get)\(\s*["']([A-Z][A-Z0-9_]{0,127})["']/g];
    for (const pattern of patterns) for (const match of text.matchAll(pattern)) emit('environment_keys', match[1], name, 'environment lookup', 0.9);
    if (/^\.env\.(?:example|template|sample)$/.test(base)) for (const match of text.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]{0,127})\s*=/gm)) emit('environment_keys', match[1], name, 'template key');
    if (/^(?:docker-compose|compose)(?:[.-].*)?\.ya?ml$/i.test(base)) {
      for (const match of text.matchAll(/\$\{([A-Z][A-Z0-9_]{0,127})(?::[-?][^}]*)?\}/g)) emit('environment_keys', match[1], name, 'Compose interpolation');
      for (const match of text.matchAll(/^\s*-\s*["']?(?:\d{1,5}:)?(\d{1,5})(?:\/tcp|\/udp)?["']?\s*$/gm)) if (+match[1] > 0 && +match[1] <= 65535) emit('probable_ports', match[1], name, 'Compose probable port mapping', 0.65);
    }
  }
  for (const category of PROFILE_CATEGORIES) {
    detections[category].sort((a, b) => { const x = JSON.stringify(a); const y = JSON.stringify(b); return x < y ? -1 : x > y ? 1 : 0; });
    if (!detections[category].length) detections[category].push({ value: 'UNKNOWN', confidence: 0, source_path: null, pattern: 'No supported evidence detected' });
  }
  return { schema_version: 1, content_sha256: hash.digest('hex'), detections, skipped };
}
