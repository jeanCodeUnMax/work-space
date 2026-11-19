import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { confinedDestination, selectDeliverable } from './nim-worker-contract.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('expected_artifact takes precedence over a source path mentioned in the prompt', (t) => {
  const root = fixture(t);
  const source = path.join(root, 'comms.js');
  const expected = path.join(root, 'reports', 'smoke.txt');
  fs.writeFileSync(source, 'source-preserved');
  const artifact = selectDeliverable('851', { expected_artifact: expected }, source);
  const destination = confinedDestination(artifact, root);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, 'smoke-ok');
  assert.equal(fs.readFileSync(source, 'utf8'), 'source-preserved');
  assert.equal(fs.readFileSync(expected, 'utf8'), 'smoke-ok');
});

test('formal text-only tasks never treat incidental source paths as destinations', () => {
  assert.equal(selectDeliverable('851', {}, '.agent/agent-bridge/comms.js'), null);
  assert.throws(() => selectDeliverable('851', null, '.agent/agent-bridge/comms.js'), /aucune ecriture/);
});

test('outside-workspace destinations are rejected before writing', (t) => {
  const root = fixture(t);
  assert.throws(() => confinedDestination('../outside.txt', root), /hors workspace/);
});

test('an existing symbolic-link ancestor cannot redirect a new artifact outside the workspace', (t) => {
  const root = fixture(t);
  const outside = fixture(t);
  const link = path.join(root, 'linked');
  try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Creation de liens non autorisee par OS'); throw error; }
  assert.throws(() => confinedDestination(path.join(link, 'artifact.txt'), root), /hors workspace/);
  assert.equal(fs.existsSync(path.join(outside, 'artifact.txt')), false);
});
