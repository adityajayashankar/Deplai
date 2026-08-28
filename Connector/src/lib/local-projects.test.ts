import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import { extractZipToProject, resolveSafeProjectPath } from './local-projects';

describe('resolveSafeProjectPath', () => {
  it('keeps files inside the project root', () => {
    const base = path.join(os.tmpdir(), 'deplai-safe-proj');
    const resolved = resolveSafeProjectPath(base, 'src/app.ts');
    assert.equal(resolved, path.resolve(base, 'src/app.ts'));
  });

  it('rejects parent and absolute paths', () => {
    const base = path.join(os.tmpdir(), 'deplai-safe-proj');
    assert.throws(() => resolveSafeProjectPath(base, '../outside.txt'));
    assert.throws(() => resolveSafeProjectPath(base, 'ok/../../outside.txt'));
    assert.throws(() => resolveSafeProjectPath(base, '/etc/passwd'));
  });
});

describe('extractZipToProject', () => {
  it('refuses zip-slip entries that escape the project directory', async () => {
    const userId = `zip-slip-${Date.now()}`;
    const projectId = 'proj-1';
    const zip = new AdmZip();
    zip.addFile('src/index.ts', Buffer.from('export {}\n'));
    const slip = zip.addFile('payload.txt', Buffer.from('nope'));
    slip.entryName = '../escaped.txt';

    await assert.rejects(
      () => extractZipToProject(zip.toBuffer(), userId, projectId),
      /directory traversal/i,
    );

    const escapedBesideUser = path.resolve(process.cwd(), 'tmp', 'local-projects', userId, 'escaped.txt');
    const escapedAtRoot = path.resolve(process.cwd(), 'tmp', 'local-projects', 'escaped.txt');
    assert.equal(fs.existsSync(escapedBesideUser), false);
    assert.equal(fs.existsSync(escapedAtRoot), false);
  });
});
