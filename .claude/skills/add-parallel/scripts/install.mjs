import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const skillDir = fileURLToPath(new URL('..', import.meta.url));
const importLine =
  "import { withParallelSearch } from './parallel-search.js';\n";
const supportedQueryHash =
  '0b134c72e995d84cea4aef3e0740b4132a6687d4e6ac1720417ddafadbdd52aa';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function queryBlock(source) {
  const start = source.indexOf('async function runQuery(');
  const end = source.indexOf('\ninterface ScriptResult', start);
  if (start < 0 || end < 0)
    throw new Error('Unsupported agent runner: runQuery was not found');
  return source.slice(start, end);
}

function transform(source, remove) {
  const installed = source.includes(importLine);
  const original = installed
    ? source
        .replace(importLine, '')
        .replace('query(withParallelSearch({', 'query({')
        .replace(
          '  }))) {\n    messageCount++;',
          '  })) {\n    messageCount++;',
        )
    : source;
  if (hash(queryBlock(original)) !== supportedQueryHash) {
    throw new Error(
      'Customized or newer runQuery: review the integration manually; no files changed',
    );
  }
  if (remove) return original;
  if (installed) return source;
  const block = queryBlock(source);
  const wrapped = block
    .replace('query({', 'query(withParallelSearch({')
    .replace('  })) {\n    messageCount++;', '  }))) {\n    messageCount++;');
  if (!source.includes("import fs from 'fs';"))
    throw new Error('Unsupported import section; no files changed');
  return source
    .replace(block, wrapped)
    .replace("import fs from 'fs';", importLine + "import fs from 'fs';");
}

/** Validate all destinations before writing; never replace another installation. */
export function install(root, { check = false, remove = false } = {}) {
  root = fs.realpathSync(root);
  const runners = [path.join(root, 'container/agent-runner/src')];
  const sessions = path.join(root, 'data/sessions');
  if (fs.existsSync(sessions)) {
    for (const group of fs.readdirSync(sessions)) {
      const cached = path.join(sessions, group, 'agent-runner-src');
      if (fs.existsSync(path.join(cached, 'index.ts'))) runners.push(cached);
    }
  }
  const indexes = runners.map((dir) => {
    const file = path.join(dir, 'index.ts');
    const original = fs.readFileSync(file, 'utf8');
    return { file, original, content: transform(original, remove) };
  });
  const helper = fs.readFileSync(
    path.join(skillDir, 'runtime/parallel-search.ts'),
    'utf8',
  );
  const copies = runners.map((dir) => ({
    file: path.join(dir, 'parallel-search.ts'),
    content: helper,
  }));
  copies.push({
    file: path.join(root, 'container/skills/parallel-search/SKILL.md'),
    content: fs.readFileSync(path.join(skillDir, 'runtime/SKILL.md'), 'utf8'),
  });
  for (const { file, content } of copies) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== content) {
      throw new Error(
        `Existing customized file: ${path.relative(root, file)}; no files changed`,
      );
    }
  }
  const changed = indexes.some((i) => i.original !== i.content);
  if (check) return { changed, mode: remove ? 'remove' : 'install' };
  const snapshots = [
    ...indexes.map((i) => i.file),
    ...copies.map((c) => c.file),
  ].map((file) => ({
    file,
    content: fs.existsSync(file) ? fs.readFileSync(file) : null,
  }));
  try {
    for (const { file, content } of copies) {
      if (remove) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      }
    }
    // Write root first, caches last: NanoClaw compares mtimes at startup. This
    // preserves supported per-group customizations outside runQuery as well.
    for (const { file, content } of indexes) fs.writeFileSync(file, content);
  } catch (error) {
    for (const { file, content } of snapshots) {
      if (content === null) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } else fs.writeFileSync(file, content);
    }
    throw error;
  }
  return { changed, mode: remove ? 'remove' : 'install' };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((arg) => arg.startsWith('--')));
  if (
    [...flags].some((flag) => !['--check', '--remove'].includes(flag)) ||
    args.filter((arg) => !arg.startsWith('--')).length > 1
  ) {
    console.error('Usage: node install.mjs [repository] [--check] [--remove]');
    process.exitCode = 1;
  } else {
    try {
      const result = install(
        args.find((arg) => !arg.startsWith('--')) ?? process.cwd(),
        {
          check: flags.has('--check'),
          remove: flags.has('--remove'),
        },
      );
      console.log(
        `${result.mode}: ${result.changed ? 'ready' : 'already applied'}${flags.has('--check') ? ' (check only)' : ''}`,
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
