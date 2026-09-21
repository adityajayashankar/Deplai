import { COMPONENTS, artifactSchemas, type ArtifactBundle } from './artifact-schemas';

const sha = 'a'.repeat(40);
type Service = ArtifactBundle['runtime.yaml']['services'][number];
type Resource = ArtifactBundle['runtime.yaml']['resources'][number];
function service(id: string, type: Service['type'], framework: string, dependencies: string[] = []): Service {
  return { id, type, framework, directory: `apps/${id}`, install: ['npm', 'ci'], dev: ['npm', 'run', 'dev'], build: ['npm', 'run', 'build'], production: ['npm', 'start'], port: type === 'worker' ? null : 3000,
    public: type !== 'worker', dependencies, health_check: type === 'worker' ? { type: 'command', argv: ['node', 'health.js'], timeout_seconds: 10 } : { type: 'http', path: '/health', port: 3000, timeout_seconds: 10 }, required_environment_keys: [], secret_references: [] };
}
function resource(id: string, type: Resource['type'], technology: string): Resource { return { id, type, technology, dependencies: [], secret_references: [] }; }
export function artifactFixture(kind: 'frontend-only' | 'next-postgres' | 'react-fastapi-postgres' | 'redis-worker' | 'queue-based'): ArtifactBundle {
  const services = [service('web', 'frontend', kind === 'next-postgres' ? 'Next.js' : 'React')];
  const resources: Resource[] = [];
  if (kind !== 'frontend-only') resources.push(resource('db', 'postgres', 'PostgreSQL'));
  if (kind === 'next-postgres') services[0].dependencies = ['db'];
  if (['react-fastapi-postgres', 'redis-worker', 'queue-based'].includes(kind)) {
    services[0].dependencies = ['api'];
    const api = service('api', 'backend', 'FastAPI', ['db']);
    api.install = ['pip', 'install', '-r', 'requirements.txt']; api.dev = ['uvicorn', 'main:app', '--host', '0.0.0.0']; api.production = [...api.dev]; api.build = null;
    services.push(api);
  }
  if (kind === 'redis-worker') { resources.push(resource('cache', 'redis', 'Redis')); services.push(service('worker', 'worker', 'Node.js', ['db', 'cache'])); }
  if (kind === 'queue-based') { resources.push(resource('jobs', 'queue', 'RabbitMQ')); services.push(service('worker', 'worker', 'Node.js', ['db', 'jobs'])); services[1].dependencies.push('jobs'); }
  const components = artifactSchemas['architecture.yaml'].shape.components.parse(Object.fromEntries(COMPONENTS.map(key => [key, { selected: false, technology: null, reason: 'Not required for this application.', requirement_ids: [], alternatives: [], implementation_complexity: 'None', preview_complexity: 'None', operating_cost: 'None' }])));
  function select(key: typeof COMPONENTS[number], technology: string) { components[key] = { selected: true, technology, reason: 'Required by the product workflow.', requirement_ids: ['feature-main'], alternatives: [{ technology: 'Separate managed platform', rejection_reason: 'Additional complexity for the required workflow.' }], implementation_complexity: 'One component', preview_complexity: 'One isolated service or resource', operating_cost: 'Runtime resources depend on usage' }; }
  select('frontend', services[0].framework);
  if (resources.length) select('database', 'PostgreSQL');
  if (services.some(s => s.id === 'api')) select('backend', 'FastAPI');
  if (kind === 'redis-worker') select('cache', 'Redis');
  if (kind === 'queue-based') select('queue', 'RabbitMQ');
  if (services.some(s => s.type === 'worker')) select('workers', 'Node.js');
  return {
    'product.yaml': { schema_version: 1, purpose: 'A reference application fixture.', users: [{ id: 'user', description: 'Application user' }], roles: [], features: [{ id: 'feature-main', description: 'Use the main application workflow.' }], journeys: [], pages: [], business_rules: [], domain_entities: [], integrations: [], kpis: [], assumptions: [], non_functional_requirements: [], acceptance_criteria: [{ id: 'accept-main', description: 'Main workflow succeeds.' }] },
    'repository.yaml': { schema_version: 1, source_revision: sha, policy: 'PRESERVE_EXISTING', frameworks: [], modules: [], services: [], apis: [], databases: [], auth: [], workers: [], queues: [], jobs: [], storage: [], integrations: [], relationships: [], evidence: [] },
    'architecture.yaml': { schema_version: 1, style: 'Smallest architecture for the required workflow', components },
    'runtime.yaml': { schema_version: 1, services, resources, routes: [{ path: '/', target: 'web' }] },
    'preview.yaml': { schema_version: 1, origin: 'https://preview.example.test', routes: [{ path: '/', target: 'web' }], source_revision: sha, worktree_id: 'worktree-one', isolation_profile: 'gvisor', network_policy: { public_egress: 'deny', host: false, metadata: false, private_networks: false, sibling_previews: false }, hot_reload: true, websockets: true, sse: true, cookie_strategy: 'isolated-origin', idle_ttl_seconds: 900, hard_ttl_seconds: 3600, resource_profile: 'build-default-v1' },
    'secrets.schema.yaml': { schema_version: 1, secrets: [] },
    'session.yaml': { schema_version: 1, session_id: 'session-one', project_id: 'project-one', organization_id: 'org-one', owner_user_id: 'user-one', source_type: 'NEW_PROJECT', source_revision: null, state: 'DRAFT', active_worktree_id: null, active_preview_revision: null, preview_id: null, secret_scope_id: 'secret-scope-one', quota_profile_id: 'build-default-v1' },
    'task-graph.json': { schema_version: 1, tasks: [{ id: 'task-main', objective: 'Implement the workflow', specialist: 'frontend-engineer', dependencies: [], read_paths: ['apps/web'], write_paths: ['apps/web'], required_skills: [], required_tools: ['read', 'patch'], expected_artifacts: ['apps/web/page.tsx'], acceptance_criteria: ['accept-main'], verification_commands: [['npm', 'test']], rollback_boundary: '.' }] },
  };
}

export function invalidArtifactFixture(kind: 'dependency-cycle' | 'secret-reference' | 'preview-route'): ArtifactBundle {
  const bundle = artifactFixture('react-fastapi-postgres');
  if (kind === 'dependency-cycle') bundle['runtime.yaml'].services[1].dependencies.push('web');
  if (kind === 'secret-reference') bundle['runtime.yaml'].services[0].secret_references.push('undefined-secret');
  if (kind === 'preview-route') bundle['preview.yaml'].routes[0].target = 'missing';
  return bundle;
}
