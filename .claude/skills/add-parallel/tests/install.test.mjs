import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { install } from '../scripts/install.mjs';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const runner = execFileSync(
  'git',
  ['show', 'HEAD:container/agent-runner/src/index.ts'],
  {
    cwd: repo,
    encoding: 'utf8',
  },
);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'container/agent-runner/src/index.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, runner);
  return { root, file };
}

test('check is read-only; install, repeat and removal preserve the runner', (t) => {
  const { root, file } = fixture(t);
  assert.equal(install(root, { check: true }).changed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), runner);
  assert.equal(install(root).changed, true);
  const installed = fs.readFileSync(file, 'utf8');
  assert.match(installed, /query\(withParallelSearch\(\{/);
  assert.equal(install(root).changed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), installed);
  assert.equal(install(root, { remove: true }).changed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), runner);
  assert.equal(
    fs.existsSync(
      path.join(root, 'container/agent-runner/src/parallel-search.ts'),
    ),
    false,
  );
});

test('customized query options fail before any writes', (t) => {
  const { root, file } = fixture(t);
  const custom = runner.replace(
    "'WebSearch', 'WebFetch',",
    "'WebSearch', 'WebFetch', 'custom-provider',",
  );
  fs.writeFileSync(file, custom);
  assert.throws(() => install(root), /Customized or newer runQuery/);
  assert.equal(fs.readFileSync(file, 'utf8'), custom);
  assert.equal(
    fs.existsSync(
      path.join(root, 'container/agent-runner/src/parallel-search.ts'),
    ),
    false,
  );
});

test('existing cached runners are checked and preserved outside query options', (t) => {
  const { root, file } = fixture(t);
  const cached = path.join(
    root,
    'data/sessions/main/agent-runner-src/index.ts',
  );
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.writeFileSync(cached, `// Group customization\n${runner}`);
  install(root);
  assert.match(fs.readFileSync(cached, 'utf8'), /^\/\/ Group customization/);
  assert.match(fs.readFileSync(cached, 'utf8'), /query\(withParallelSearch/);
  assert.ok(fs.statSync(cached).mtimeMs >= fs.statSync(file).mtimeMs);
  install(root, { remove: true });
  assert.equal(
    fs.readFileSync(cached, 'utf8'),
    `// Group customization\n${runner}`,
  );
});

test('one incompatible group cache prevents partial installation', (t) => {
  const { root, file } = fixture(t);
  const cached = path.join(
    root,
    'data/sessions/custom/agent-runner-src/index.ts',
  );
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.writeFileSync(
    cached,
    runner.replace("'WebSearch', 'WebFetch',", "'CustomSearch',"),
  );
  assert.throws(() => install(root), /Customized or newer runQuery/);
  assert.equal(fs.readFileSync(file, 'utf8'), runner);
});

test('install and remove never overwrite customized installed payload', (t) => {
  const { root } = fixture(t);
  install(root);
  const helper = path.join(
    root,
    'container/agent-runner/src/parallel-search.ts',
  );
  fs.appendFileSync(helper, '\n// customization\n');
  assert.throws(() => install(root), /Existing customized file/);
  assert.throws(
    () => install(root, { remove: true }),
    /Existing customized file/,
  );
  assert.match(fs.readFileSync(helper, 'utf8'), /customization/);
});
