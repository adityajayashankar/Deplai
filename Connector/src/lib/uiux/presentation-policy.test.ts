import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isEditableUiPath, isSafeUiReadPath, validatePresentationChanges } from './presentation-policy';

const baseline = `import { useState } from 'react';
export default function Page() {
  const [count, setCount] = useState(0);
  const save = () => fetch('/api/save', { method: 'POST' });
  return <div className="p-2"><h1>Welcome</h1><button onClick={save}>Save</button><a href="/account">Account</a><p>{count > 0 ? 'Active' : 'Idle'}</p></div>;
}`;
const check = (after: string, before = baseline) => validatePresentationChanges([{ path: 'src/app/page.tsx', before, after }]);

test('accepts static native styling, copy and inert layout wrappers', () => {
  const after = baseline.replace('className="p-2"', 'className="p-8 bg-white" style={{ padding: 24, color: "black" }}')
    .replace('<h1>Welcome</h1>', '<section><h1>Hello there</h1></section>')
    .replace('>Save</button>', '>Save changes</button>');
  assert.deepEqual(check(after).conflicts, []);
});

test('rejects behavior changes in hooks, calls, event handlers, routes and dynamic copy', () => {
  for (const after of [
    baseline.replace('useState(0)', 'useState(1)'),
    baseline.replace("'/api/save'", "'/api/delete'"),
    baseline.replace('onClick={save}', 'onClick={() => setCount(9)}'),
    baseline.replace('href="/account"', 'href="/logout"'),
    baseline.replace("'Active'", "'Deleted'"),
    baseline.replace('count > 0', 'count >= 0'),
    baseline.replace('return <div', 'setCount(100); return <div'),
  ]) assert.equal(check(after).ok, false, after);
});

test('preserves component props, form semantics, spread props and interactive ordering', () => {
  const before = 'export const Page = () => <div><Widget className="original" /><form action="/save"><input name="email" type="email" /><button>Save</button></form><a href="/help">Help</a></div>';
  for (const after of [before.replace('original', 'changed'), before.replace('name="email"', 'name="password"'), before.replace('type="email"', 'type="text"'), before.replace('<input ', '<input {...props} '), before.replace('<button>Save</button>', '').replace('<input', '<button>Save</button><input')]) assert.equal(check(after, before).ok, false);
});

test('retains expression structure while allowing styling inside mapped JSX', () => {
  const before = 'export const Page = () => <main>{items.map(item => <button key={item.id} onClick={() => pick(item.id)} className="p-2">{item.name}</button>)}</main>';
  assert.equal(check(before.replace('p-2', 'p-4'), before).ok, true);
  assert.equal(check(before.replace('item.id)', 'item.other)'), before).ok, false);
});

test('rejects executable JSX, hidden controls, arbitrary CSS and malformed edits', () => {
  for (const after of [baseline.replace('<h1>Welcome</h1>', '<script>alert(1)</script>'), baseline.replace('p-2', 'hidden'), baseline.replace('p-2', 'hover:opacity-0'), baseline.replace('p-2', '[display:none]'), baseline.replace('<div className="p-2">', '<div style={{ pointerEvents: "none" }}>'), baseline.slice(0, -20)]) assert.equal(check(after).ok, false);
});

test('rejects new source, deletion, duplicate paths, oversized patches and non-presentation paths', () => {
  const change = { path: 'src/page.tsx', before: baseline, after: baseline };
  for (const changes of [[{ ...change, before: null }], [{ ...change, after: null }], [change, { ...change, path: 'SRC/page.tsx' }], [{ ...change, after: ' '.repeat(128 * 1024 + 1) }], Array.from({ length: 17 }, (_, i) => ({ ...change, path: `src/${i}.tsx` }))]) assert.equal(validatePresentationChanges(changes).ok, false);
  for (const path of ['../page.tsx', '/page.tsx', 'C:/page.tsx', 'src\\page.tsx', 'src/api/page.tsx', 'src/hooks/useCart.tsx', 'src/services/view.tsx', 'src/app/route.tsx', 'src/actions.tsx', 'src/view.test.tsx', 'src/tokens.ts', 'package.json', 'src/page.tsx.']) assert.equal(isEditableUiPath(path), false, path);
});

test('CSS supports local styling but rejects network access and executable or concealed values', () => {
  const css = (after: string) => validatePresentationChanges([{ path: 'src/theme.css', before: null, after }]);
  assert.equal(css('.card { color: black; background-image: url(/images/card.png); }').ok, true);
  for (const after of ['@import "https://evil.invalid/x.css";', '.x { background: url(https://evil.invalid/a.png) }', '.x { background: url(//evil.invalid/a.png) }', '.x { width: expression(alert(1)) }', '.x { -moz-binding: url(/a.xml) }', '.x { behavior: url(/a.htc) }', '@im/**/port "a.css";', '.x { background: u\\72l(https://evil.invalid/x) }', 'button { display: none }', 'button { opacity: 0 }']) assert.equal(css(after).ok, false, after);
});

test('read allowlist hides secrets, binary, generated content and unsafe paths', () => {
  for (const path of ['package.json', 'next.config.js', 'src/components/Card.tsx', 'README.md']) assert.equal(isSafeUiReadPath(path), true, path);
  for (const path of ['.env', '.env.local', 'src/secrets.json', 'src/api-token.json', '.git/config', 'node_modules/a.ts', 'dist/a.js', 'src/key.pem', 'photo.png', '../a.ts', 'src/%2e%2e/a.ts']) assert.equal(isSafeUiReadPath(path), false, path);
});
