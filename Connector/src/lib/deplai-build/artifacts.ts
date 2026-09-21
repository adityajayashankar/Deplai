import { dump, load, JSON_SCHEMA } from 'js-yaml';
import { ARTIFACT_DIRECTORIES, ARTIFACT_NAMES, artifactSchemas, type ArtifactBundle, type ArtifactName } from './artifact-schemas';

export class ArtifactError extends Error {
  constructor(readonly issues: string[]) { super(issues.join('; ')); this.name = 'ArtifactError'; }
}

// Bound decoded graph before schema traversal. Aliases, recursion and unsafe keys are refused.
function boundedTree(value: unknown, file: string): void {
  const seen = new Set<object>(); let count = 0;
  function visit(node: unknown, depth: number) {
    if (++count > 50000 || depth > 40) throw new ArtifactError([`${file}: document exceeds structural limits`]);
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) throw new ArtifactError([`${file}: YAML aliases or cycles are not supported`]);
    seen.add(node);
    for (const [key, child] of Object.entries(node)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new ArtifactError([`${file}: forbidden mapping key`]);
      visit(child, depth + 1);
    }
  }
  visit(value, 0);
}

export function validateArtifact<K extends ArtifactName>(name: K, data: unknown): ArtifactBundle[K] {
  if (!Object.hasOwn(artifactSchemas, name)) throw new ArtifactError(['Unknown artifact name']);
  boundedTree(data, name);
  const parsed = artifactSchemas[name].safeParse(data);
  if (!parsed.success) {
    // Never include values, YAML snippets, parser messages or unknown field names in errors.
    throw new ArtifactError(parsed.error.issues.map(issue => {
      const detail = issue.path[0] === 'schema_version' ? 'schema_version must be the supported integer 1'
        : issue.code === 'custom' ? issue.message
        : issue.code === 'unrecognized_keys' ? 'unknown fields are forbidden'
        : `${issue.code}; check the v1 field type and limits`;
      return `${name}:${issue.path.join('.') || '$'}: ${detail}`;
    }));
  }
  return parsed.data as ArtifactBundle[K];
}

export function parseArtifact<K extends ArtifactName>(name: K, source: string): ArtifactBundle[K] {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > 512 * 1024) throw new ArtifactError([`${name}: document exceeds 512 KiB`]);
  let data: unknown;
  try {
    if (name.endsWith('.json')) JSON.parse(source); // Enforce actual JSON syntax, then reject duplicate keys via YAML loader.
    data = load(source, { schema: JSON_SCHEMA, json: false });
  } catch { throw new ArtifactError([`${name}: malformed document, duplicate key or unsupported YAML tag`]); }
  return validateArtifact(name, data);
}

export function validateBundle(input: unknown): ArtifactBundle {
  boundedTree(input, 'bundle');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ArtifactError(['bundle: expected artifact mapping']);
  const source = input as Record<string, unknown>;
  if (Object.keys(source).some(k => !ARTIFACT_NAMES.includes(k as ArtifactName))) throw new ArtifactError(['bundle: unknown artifact']);
  const bundle = Object.fromEntries(ARTIFACT_NAMES.map(name => [name, validateArtifact(name, source[name])])) as ArtifactBundle;
  const errors: string[] = [];
  const fail = (path: string, message: string) => errors.push(`${path}: ${message}`);
  function unique(values: string[], path: string) {
    if (new Set(values).size !== values.length) fail(path, 'duplicate identifiers');
  }
  function graph(nodes: { id: string; dependencies: string[] }[], path: string) {
    unique(nodes.map(n => n.id), path);
    const byId = new Map(nodes.map(n => [n.id, n])); const visiting = new Set<string>(); const done = new Set<string>();
    function visit(id: string) {
      if (visiting.has(id)) { fail(path, 'dependency cycle; remove circular dependencies'); return; }
      if (done.has(id)) return;
      const node = byId.get(id);
      if (!node) { fail(path, 'missing dependency; declare every referenced node'); return; }
      visiting.add(id); unique(node.dependencies, `${path}.dependencies`);
      node.dependencies.forEach(visit); visiting.delete(id); done.add(id);
    }
    nodes.forEach(n => visit(n.id));
  }
  const product = bundle['product.yaml'];
  const productIds: string[] = [];
  for (const [key, value] of Object.entries(product)) if (Array.isArray(value)) unique(value.map(v => v.id), `product.yaml.${key}`);
  for (const value of Object.values(product)) if (Array.isArray(value)) productIds.push(...value.map(v => v.id));
  unique(productIds, 'product.yaml');
  const requirementIds = new Set([...product.features, ...product.non_functional_requirements, ...product.acceptance_criteria].map(v => v.id));
  for (const [key, decision] of Object.entries(bundle['architecture.yaml'].components)) {
    unique(decision.requirement_ids, `architecture.yaml.components.${key}.requirement_ids`);
    if (decision.selected && decision.requirement_ids.length === 0) fail(`architecture.yaml.components.${key}`, 'selected component requires a product requirement');
    if (decision.requirement_ids.some(id => !requirementIds.has(id))) fail(`architecture.yaml.components.${key}`, 'unknown product requirement');
  }
  const repository = bundle['repository.yaml'];
  const repoIds: string[] = [];
  for (const [key, value] of Object.entries(repository)) if (Array.isArray(value) && key !== 'evidence' && key !== 'relationships') {
    repoIds.push(...(value as { id: string }[]).map(v => v.id));
  }
  unique(repoIds, 'repository.yaml');
  if (repository.relationships.some(r => !repoIds.includes(r.from) || !repoIds.includes(r.to))) fail('repository.yaml.relationships', 'unknown repository component');
  const runtime = bundle['runtime.yaml'];
  graph([...runtime.services, ...runtime.resources], 'runtime.yaml');
  const services = new Map(runtime.services.map(s => [s.id, s]));
  for (const service of runtime.services) {
    unique(service.required_environment_keys, 'runtime.yaml.required_environment_keys');
    unique(service.secret_references, 'runtime.yaml.secret_references');
    if (service.health_check?.type === 'http' && service.health_check.port !== service.port) fail('runtime.yaml.health_check', 'HTTP health port must match service port');
  }
  for (const [file, routes] of [['runtime.yaml', runtime.routes], ['preview.yaml', bundle['preview.yaml'].routes]] as const) {
    unique(routes.map(r => r.path), `${file}.routes`);
    for (const route of routes) {
      const target = services.get(route.target);
      if (!target) fail(`${file}.routes`, 'unknown route target; reference a declared service');
      else if (!target.public || target.port === null) fail(`${file}.routes`, 'route target must be a public service with a port');
    }
  }
  const nodes = [...runtime.services, ...runtime.resources];
  const secrets = bundle['secrets.schema.yaml'].secrets; unique(secrets.map(s => s.id), 'secrets.schema.yaml');
  for (const secret of secrets) {
    unique(secret.consumers, 'secrets.schema.yaml.consumers');
    for (const consumer of secret.consumers) {
      const node = nodes.find(n => n.id === consumer);
      if (!node) fail('secrets.schema.yaml.consumers', 'unknown runtime consumer');
      else if (!node.secret_references.includes(secret.reference || secret.id)) fail('secrets.schema.yaml.consumers', 'consumer must declare the secret reference');
    }
  }
  for (const node of nodes) for (const ref of node.secret_references) {
    const secret = secrets.find(s => (s.reference || s.id) === ref);
    if (!secret) fail('runtime.yaml.secret_references', 'undefined secret; declare metadata in secrets.schema.yaml');
    else if (!secret.consumers.includes(node.id)) fail('runtime.yaml.secret_references', 'service/resource is not an authorized consumer');
  }
  const tasks = bundle['task-graph.json'].tasks; graph(tasks, 'task-graph.json');
  const acceptance = new Set(product.acceptance_criteria.map(c => c.id));
  for (const task of tasks) if (task.acceptance_criteria.length === 0 || task.acceptance_criteria.some(id => !acceptance.has(id))) fail('task-graph.json.acceptance_criteria', 'tasks require defined product acceptance IDs');
  for (const task of tasks) {
    unique(task.acceptance_criteria, 'task-graph.json.acceptance_criteria');
    unique(task.required_tools, 'task-graph.json.required_tools');
    unique(task.required_skills, 'task-graph.json.required_skills');
  }
  const session = bundle['session.yaml']; const preview = bundle['preview.yaml'];
  if (runtime.source_revision && runtime.source_revision !== preview.source_revision) fail('runtime.yaml.source_revision', 'does not match preview revision');
  if (runtime.worktree_id && runtime.worktree_id !== preview.worktree_id) fail('runtime.yaml.worktree_id', 'does not match preview worktree');
  if (session.active_preview_revision !== null && session.active_preview_revision !== preview.source_revision) fail('preview.yaml.source_revision', 'does not match session active preview revision');
  if (session.active_worktree_id !== null && session.active_worktree_id !== preview.worktree_id) fail('preview.yaml.worktree_id', 'does not match session worktree');
  if (session.source_type === 'IMPORT_REPOSITORY' && session.source_revision !== repository.source_revision) fail('repository.yaml.source_revision', 'does not match imported session revision');
  if (session.quota_profile_id !== preview.resource_profile) fail('preview.yaml.resource_profile', 'does not match session quota profile');
  if (errors.length) throw new ArtifactError([...new Set(errors)]);
  return bundle;
}

export function parseBundle(files: Record<ArtifactName, string>): ArtifactBundle {
  return validateBundle(Object.fromEntries(ARTIFACT_NAMES.map(name => [name, parseArtifact(name, files[name])])));
}

/** Returns a virtual file map; never touches an untrusted workspace or executes a command. */
export function serializeBundle(input: ArtifactBundle): Record<string, string> {
  const bundle = validateBundle(input);
  const files: Record<string, string> = {};
  for (const name of ARTIFACT_NAMES) files[`.deplai/${name}`] = name.endsWith('.json') ? JSON.stringify(bundle[name], null, 2) + '\n' : dump(bundle[name], { noRefs: true, lineWidth: 100 });
  for (const dir of ARTIFACT_DIRECTORIES) files[`.deplai/${dir}/.gitkeep`] = '';
  return files;
}
