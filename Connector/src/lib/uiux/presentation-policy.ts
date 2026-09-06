import ts from 'typescript';

export type PresentationChange = { path: string; before: string | null; after: string | null };
export type PresentationValidation = { ok: boolean; conflicts: string[]; warnings: string[] };

const MAX_BYTES = 128 * 1024;
const hiddenSegments = /^(?:\.git|node_modules|\.next|dist|build|coverage|vendor|\.venv|venv|\.ssh|\.aws|secrets?)$/i;
const protectedSegments = /^(?:api|server|services?|hooks?|stores?|auth|billing|payments?|db|database|prisma|migrations?|__tests__|tests?)$/i;

function safeSegments(path: string): string[] | null {
  if (!path || path.length > 512 || /[\\:\x00-\x1f?#%]/.test(path) || path.startsWith('/')) return null;
  const parts = path.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.endsWith('.') || p.endsWith(' ') || hiddenSegments.test(p))) return null;
  return parts;
}

/** An allowlist for prompt context, never a filesystem authorization check. */
export function isSafeUiReadPath(path: string): boolean {
  const parts = safeSegments(path);
  if (!parts) return false;
  const file = parts.at(-1)!;
  if (parts.some(p => /(?:^|[._-])(?:secret|secrets|credentials?|private[-_]?key|tokens?)(?:[._-]|$)/i.test(p))) return false;
  if (/^(?:\.env(?:\.|$)|\.npmrc$|\.pypirc$|id_rsa|id_ed25519)/i.test(file)) return false;
  return /\.(?:tsx?|jsx?|css|scss|sass|less|json|md|mdx|html|vue|svelte)$/i.test(file);
}

export function isEditableUiPath(path: string): boolean {
  const parts = safeSegments(path);
  if (!parts || !isSafeUiReadPath(path) || parts.some(p => protectedSegments.test(p))) return false;
  const file = parts.at(-1)!;
  if (/(?:^|[._-])(?:config|test|spec|middleware|instrumentation|route|actions?)(?:[._-]|$)/i.test(file)) return false;
  return /\.(?:tsx|jsx|css)$/i.test(file);
}

function checkCss(css: string): string | null {
  // Escapes and comments can conceal identifiers such as url or import. Remove
  // comments and reject escapes rather than attempting a permissive CSS parser.
  const normalized = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/\\|@import\b|(?:image-set|expression)\s*\(|(?:-moz-)?binding\s*:|behavior\s*:|(?:https?|data|javascript)\s*:|<\/?script/i.test(normalized)) return 'CSS contains an import, external resource, executable value, or escaped identifier.';
  for (const match of normalized.matchAll(/url\s*\(\s*([^)]*)\)/gi)) {
    const value = match[1].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    if (value.startsWith('//') || !/^(?:\/(?!\/)|\.?\.?\/)?[a-zA-Z0-9_./-]+\.(?:png|jpe?g|gif|webp|avif|woff2?|ttf|otf)$/i.test(value) || value.includes('..')) return 'CSS URLs must reference local image or font assets.';
  }
  if (/(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|pointer-events\s*:\s*none|opacity\s*:\s*0(?:\D|$))/i.test(normalized)) return 'CSS must not hide or disable controls.';
  return null;
}

const layoutTags = new Set(['div', 'span', 'section', 'main', 'article', 'header', 'footer', 'aside', 'nav']);
const forbiddenTags = new Set(['script', 'iframe', 'object', 'embed', 'base', 'style', 'link', 'meta']);

function staticStyle(initializer: ts.JsxAttributeValue | undefined): boolean {
  if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression || !ts.isObjectLiteralExpression(initializer.expression)) return false;
  return initializer.expression.properties.every(property => {
    if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) return false;
    if (['display', 'visibility', 'pointerEvents', 'opacity', 'content'].includes(property.name.text)) return false;
    const value = property.initializer;
    return (ts.isStringLiteral(value) && !checkCss(`value:${value.text}`)) || ts.isNumericLiteral(value) ||
      (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(value.operand));
  });
}

function classLiteral(initializer: ts.JsxAttributeValue | undefined): string | undefined {
  if (initializer && ts.isStringLiteral(initializer)) return initializer.text;
  if (initializer && ts.isJsxExpression(initializer) && initializer.expression && ts.isStringLiteral(initializer.expression)) return initializer.expression.text;
  return undefined;
}

/** Preserve all non-presentation AST structure, including dynamic JSX expressions. */
function fingerprint(source: ts.SourceFile): string {
  function visit(node: ts.Node): unknown {
    if (ts.isJsxText(node)) return null; // Plain visible copy is editable.
    if (ts.isJsxFragment(node)) return { jsx: children(node.children) };
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = opening.tagName.getText(source);
      if (forbiddenTags.has(tag.toLowerCase())) throw new Error(`Executable or embedded element <${tag}> is not supported.`);
      const native = /^[a-z][a-z0-9-]*$/.test(tag) && !tag.includes('-');
      const attrs: unknown[] = [];
      const attributeNames = new Set<string>();
      for (const attr of opening.attributes.properties) {
        if (ts.isJsxAttribute(attr)) {
          const name = attr.name.getText(source);
          if (attributeNames.has(name)) throw new Error('Duplicate JSX attributes are not supported.');
          attributeNames.add(name);
        }
        if (native && ts.isJsxAttribute(attr)) {
          const name = attr.name.getText(source);
          const className = name === 'className' ? classLiteral(attr.initializer) : undefined;
          if (className !== undefined) {
            if (/(?:^|[\s:])(?:hidden|invisible|collapse|opacity-0|pointer-events-none)(?:\s|$)|\[[^\]]*\]/i.test(className)) throw new Error('Classes that hide controls or arbitrary CSS values require manual review.');
            continue;
          }
          if (name === 'style' && staticStyle(attr.initializer)) continue;
          if (name === 'dangerouslySetInnerHTML') throw new Error('Raw HTML injection is not supported.');
        }
        attrs.push(visit(attr));
      }
      const content = ts.isJsxElement(node) ? children(node.children) : [];
      if (layoutTags.has(tag) && attrs.length === 0) return { jsx: content };
      return { jsx: [{ tag, typeArguments: opening.typeArguments?.map(visit), attrs, content }] };
    }
    const descendants: unknown[] = [];
    ts.forEachChild(node, child => { descendants.push(visit(child)); });
    return descendants.length ? [node.kind, ...descendants] : [node.kind, node.getText(source)];
  }
  function children(nodes: ts.NodeArray<ts.JsxChild>): unknown[] {
    return nodes.map(visit).flatMap(value => {
      if (value === null) return [];
      if (typeof value === 'object' && value && 'jsx' in value) return value.jsx as unknown[];
      return [value];
    });
  }
  return JSON.stringify(visit(source));
}

export function validatePresentationChanges(changes: PresentationChange[]): PresentationValidation {
  const conflicts: string[] = [];
  const warnings: string[] = [];
  if (!changes.length || changes.length > 16) conflicts.push('A UI change must contain between 1 and 16 files.');
  const seen = new Set<string>();
  for (const change of changes) {
    const { path, before, after } = change;
    if (typeof path !== 'string' || !isEditableUiPath(path)) { conflicts.push(`${path}: file is outside the editable presentation surface.`); continue; }
    if (seen.has(path.toLowerCase())) { conflicts.push(`${path}: duplicate or case-colliding path.`); continue; }
    seen.add(path.toLowerCase());
    if (typeof after !== 'string' || after.trim() === '') { conflicts.push(`${path}: deleting or emptying files is not allowed.`); continue; }
    if ((before !== null && typeof before !== 'string') || Buffer.byteLength(after) > MAX_BYTES || (before && Buffer.byteLength(before) > MAX_BYTES)) { conflicts.push(`${path}: invalid baseline or file exceeds 128 KiB.`); continue; }
    if (/\.css$/i.test(path)) {
      // Existing framework imports (for example Tailwind) are configuration.
      // Preserve them exactly, while rejecting new or changed import targets.
      const imports = (text: string) => [...text.matchAll(/@import\s+[^;{}]+;/gi)].map(match => match[0]);
      const beforeImports = imports(before || '');
      const afterImports = imports(after);
      if (JSON.stringify(beforeImports) !== JSON.stringify(afterImports)) {
        conflicts.push(`${path}: CSS imports must remain unchanged.`);
        continue;
      }
      const reason = checkCss(after.replace(/@import\s+[^;{}]+;/gi, ''));
      if (reason) conflicts.push(`${path}: ${reason}`);
      continue;
    }
    if (before === null || before.trim() === '') { conflicts.push(`${path}: source edits require an existing baseline; new source files need manual review.`); continue; }
    try {
      const parse = (text: string) => {
        const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, /\.tsx$/i.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.JSX);
        const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
        if (diagnostics.length) throw new Error('Source contains a syntax error.');
        return file;
      };
      if (fingerprint(parse(before)) !== fingerprint(parse(after))) conflicts.push(`${path}: business logic, component contracts, dynamic expressions, or interactive structure changed.`);
    } catch (error) {
      conflicts.push(`${path}: ${error instanceof Error ? error.message : 'Source could not be checked.'}`);
    }
  }
  if (changes.length) warnings.push('Static guards preserve code structure, but CSS, copy, and layout can still affect accessibility and usability. Review the PR and the application before merging.');
  return { ok: conflicts.length === 0, conflicts, warnings };
}
