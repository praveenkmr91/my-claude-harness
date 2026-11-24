'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'automation', 'hydrogen-catalogue.cjs');
const HYDROGEN_TS = path.join(os.homedir(), 'Documents', 'projects', 'hydrogen', 'node_modules', 'typescript');
const TS_ABSENT = fs.existsSync(HYDROGEN_TS) ? false : `typescript not found at ${HYDROGEN_TS}`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydrogen-catalogue-'));
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

let seq = 0;
const freshDir = (label) => fs.mkdtempSync(path.join(tmpDir, `${label}-${seq++}-`));

function put(base, relative, content = '') {
  const file = path.join(base, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function run(home, target, script = SCRIPT) {
  return spawnSync(process.execPath, [script, target], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, HYDROGEN_TS },
  });
}

const PACKAGES = '@additiv-hydrogen';

const GET_THING = "export const useThing = () => client.get('/v1/things/list');\n";

function makeApp() {
  const home = freshDir('home');
  const app = path.join(home, 'apps', 'app-one');
  const installed = path.join(app, 'node_modules', PACKAGES);
  const vendored = path.join(app, 'src', 'core', 'additiv-hydrogen');

  put(vendored, 'src-pkg/index.ts', [
    "export { useThing } from './use-thing';",
    "export type { Thing } from './types';",
    "import { sharedFlag } from '@additiv-hydrogen/dist-pkg';",
    'export class Store {}',
    'export enum Mode { Fast }',
    'export const flag = sharedFlag;',
    '',
  ].join('\n'));
  put(vendored, 'src-pkg/types.ts', 'export interface Thing { id: string }\n');
  put(vendored, 'src-pkg/use-thing.ts', [
    GET_THING,
    'const params = new URLSearchParams();',
    "export const tab = params.get('tab');",
    '',
  ].join('\n'));
  put(vendored, 'src-pkg/hooks/inner/use-deep.ts', "export const useDeep = () => client.get('/v1/deep');\n");
  put(vendored, 'src-pkg/hooks/next-line.ts', 'export const save = () => client.post(\n  \'/v1/next-line\',\n);\n');
  put(vendored, 'src-pkg/hooks/template.ts', 'export const read = (id, fileId) => client.get(`/v2/documents/${id}/files/${fileId}`);\n');
  put(vendored, 'src-pkg/hooks/double-quoted.ts', 'export const remove = () => client.delete("/v1/remove");\n');
  for (const skipped of ['mocks/use-thing.ts', 'openapi/spec.ts', 'handlers.ts', 'use-thing.spec.ts', 'use-thing.stories.tsx', 'use-thing.composition.tsx']) {
    put(vendored, `src-pkg/${skipped}`, "export const skipped = () => client.get('/v9/skipped');\n");
  }
  put(vendored, 'src-pkg/package.json', JSON.stringify({ name: `${PACKAGES}/src-pkg`, version: '1.2.3' }));
  fs.mkdirSync(installed, { recursive: true });
  fs.symlinkSync(path.join(vendored, 'src-pkg'), path.join(installed, 'src-pkg'));

  put(installed, 'dist-pkg/dist/index.d.ts', 'export declare const sharedFlag: boolean;\nexport interface DistShape { id: string }\n');
  put(installed, 'dist-pkg/dist/index.js', "exports.load = () => client.get('/v1/dist-only');\n");
  put(installed, 'dist-pkg/package.json', JSON.stringify({ version: '2.0.0' }));

  put(installed, 'both-pkg/index.ts', "export { both } from './both';\n");
  put(installed, 'both-pkg/both.ts', "export const both = () => client.put('/v1/both');\n");
  put(installed, 'both-pkg/dist/index.d.ts', 'export declare const both: () => void;\n');
  put(installed, 'both-pkg/dist/both.js', "exports.both = () => client.put('/v1/both');\n");
  put(installed, 'both-pkg/package.json', JSON.stringify({ version: '3.0.0' }));

  put(installed, 'barrel-pkg/index.ts', "export * from './first';\nexport * from './second';\n");
  put(installed, 'barrel-pkg/first.ts', 'export const first = 1;\n');
  put(installed, 'barrel-pkg/second.ts', 'export interface Second { id: string }\n');
  put(installed, 'barrel-pkg/package.json', JSON.stringify({ version: '4.0.0' }));

  put(installed, 'empty-pkg/package.json', JSON.stringify({ version: '5.0.0' }));

  put(installed, 'consumer-pkg/index.ts', [
    "import type { Thing } from '@additiv-hydrogen/src-pkg';",
    "export { first } from '@additiv-hydrogen/barrel-pkg/first';",
    "export const lazy = () => import('@additiv-hydrogen/both-pkg');",
    'export type Local = Thing;',
    '',
  ].join('\n'));
  put(installed, 'consumer-pkg/package.json', JSON.stringify({ version: '6.0.0' }));

  put(app, 'src/pages/home.tsx', "import { useThing } from '@additiv-hydrogen/src-pkg';\nexport const Home = () => useThing;\n");
  put(vendored, 'copy/index.ts', "import { flag } from '@additiv-hydrogen/src-pkg';\nexport const copy = flag;\n");
  return { home, app };
}

const catalogueOf = (home, name) =>
  JSON.parse(fs.readFileSync(path.join(home, '.claude', 'state', 'hydrogen-map', name, 'catalogue.json'), 'utf8'));
const packageNamed = (catalogue, name) => catalogue.packages.find((pkg) => pkg.name === `${PACKAGES}/${name}`);
const exportsOf = (pkg) => Object.fromEntries(pkg.exports.map(({ name, kind }) => [name, kind]));
const endpointKeys = (pkg) => pkg.endpoints.map(({ method, path: endpoint }) => `${method} ${endpoint}`).sort();

test('hydrogen catalogue of an app', { skip: TS_ABSENT }, async (t) => {
  const { home, app } = makeApp();
  const result = run(home, app);
  assert.equal(result.status, 0, result.stderr);
  const catalogue = catalogueOf(home, 'app-one');

  await t.test('prints the catalogue path and records the target and a key', () => {
    assert.equal(result.stdout.trim(), path.join(home, '.claude', 'state', 'hydrogen-map', 'app-one', 'catalogue.json'));
    assert.equal(catalogue.meta.target, app);
    assert.match(catalogue.meta.key, /^[0-9a-f]{64}$/);
  });

  await t.test('a source entry lists values and types, classes and enums as values', () => {
    const pkg = packageNamed(catalogue, 'src-pkg');
    assert.deepEqual(exportsOf(pkg), { Mode: 'value', Store: 'value', Thing: 'type', flag: 'value', useThing: 'value' });
    assert.equal(pkg.entry, 'index.ts');
    assert.equal(pkg.version, '1.2.3');
  });

  await t.test('a symlinked package keeps its node_modules path as dir', () => {
    assert.equal(packageNamed(catalogue, 'src-pkg').dir, path.join('node_modules', PACKAGES, 'src-pkg'));
  });

  await t.test('a dist/index.d.ts entry lists its exports', () => {
    const pkg = packageNamed(catalogue, 'dist-pkg');
    assert.deepEqual(exportsOf(pkg), { DistShape: 'type', sharedFlag: 'value' });
    assert.equal(pkg.entry, 'dist/index.d.ts');
  });

  await t.test('an export * barrel lists the names of both modules', () => {
    assert.deepEqual(exportsOf(packageNamed(catalogue, 'barrel-pkg')), { Second: 'type', first: 'value' });
  });

  await t.test('a package with no entry file is listed with empty exports', () => {
    const pkg = packageNamed(catalogue, 'empty-pkg');
    assert.deepEqual(pkg.exports, []);
    assert.equal(pkg.entry, null);
  });

  await t.test('endpoints cover subfolders, a path on the next line, both quote styles and a template path', () => {
    assert.deepEqual(endpointKeys(packageNamed(catalogue, 'src-pkg')), [
      'DELETE /v1/remove',
      'GET /v1/deep',
      'GET /v1/things/list',
      'GET /v2/documents/{id}/files/{fileId}',
      'POST /v1/next-line',
    ]);
    const deep = packageNamed(catalogue, 'src-pkg').endpoints.find((endpoint) => endpoint.path === '/v1/deep');
    assert.deepEqual(deep, { method: 'GET', path: '/v1/deep', file: path.join('hooks', 'inner', 'use-deep.ts'), line: 1 });
  });

  await t.test('mock, spec, stories, composition, handlers and openapi hits are skipped', () => {
    for (const pkg of catalogue.packages) {
      assert.ok(!endpointKeys(pkg).includes('GET /v9/skipped'), `${pkg.name} lists a skipped file`);
    }
  });

  await t.test('a package with source and dist lists each call once, from the source', () => {
    const pkg = packageNamed(catalogue, 'both-pkg');
    assert.deepEqual(pkg.endpoints.map(({ method, path: endpoint, file }) => [method, endpoint, file]), [['PUT', '/v1/both', 'both.ts']]);
  });

  await t.test('a dist-only package lists the calls in its compiled files', () => {
    assert.deepEqual(endpointKeys(packageNamed(catalogue, 'dist-pkg')), ['GET /v1/dist-only']);
  });

  await t.test('importers cover packages and app files, and every import form, subpaths included', () => {
    const importers = (name) => packageNamed(catalogue, name).importers.map(({ from, file }) => `${from.replace(`${PACKAGES}/`, '')} ${file}`);
    assert.deepEqual(importers('src-pkg'), [
      `consumer-pkg ${path.join('node_modules', PACKAGES, 'consumer-pkg', 'index.ts')}`,
      `src ${path.join('src', 'pages', 'home.tsx')}`,
    ]);
    assert.deepEqual(importers('barrel-pkg'), [`consumer-pkg ${path.join('node_modules', PACKAGES, 'consumer-pkg', 'index.ts')}`]);
    assert.deepEqual(importers('both-pkg'), [`consumer-pkg ${path.join('node_modules', PACKAGES, 'consumer-pkg', 'index.ts')}`]);
    assert.deepEqual(importers('dist-pkg'), [`src-pkg ${path.join('node_modules', PACKAGES, 'src-pkg', 'index.ts')}`]);
  });

  await t.test('the vendored src copy is not walked as app source', () => {
    const fromSrc = packageNamed(catalogue, 'src-pkg').importers.filter(({ from }) => from === 'src');
    assert.deepEqual(fromSrc.map(({ file }) => file), [path.join('src', 'pages', 'home.tsx')]);
  });
});

test('hydrogen catalogue of the monorepo', { skip: TS_ABSENT }, () => {
  const home = freshDir('home');
  const root = path.join(home, 'Documents', 'projects', 'hydrogen');
  put(root, '.bitmap', `/* generated, do not edit */\n${JSON.stringify({
    'data/rest/use-thing': { name: 'data/rest/use-thing', scope: 'additiv-hydrogen', version: '5.0.2', mainFile: 'index.ts', rootDir: 'hydrogen/data/rest/use-thing' },
    'widgets/thing-view': { name: 'widgets/thing-view', scope: 'additiv-hydrogen', version: '1.0.0', mainFile: 'index.ts', rootDir: 'hydrogen/widgets/thing-view' },
    'ui/missing': { name: 'ui/missing', scope: 'additiv-hydrogen', version: '1.0.0', mainFile: 'index.ts', rootDir: 'hydrogen/ui/missing' },
  })}`);
  put(root, 'hydrogen/data/rest/use-thing/index.ts', "export { useThing } from './use-thing';\n");
  put(root, 'hydrogen/data/rest/use-thing/use-thing.ts', GET_THING);
  put(root, 'hydrogen/widgets/thing-view/index.ts', "import { useThing } from '@additiv-hydrogen/data.rest.use-thing';\nexport const view = useThing;\n");

  const result = run(home, 'monorepo');
  assert.equal(result.status, 0, result.stderr);
  const catalogue = catalogueOf(home, 'monorepo');

  assert.equal(catalogue.meta.target, 'monorepo');
  assert.deepEqual(catalogue.packages.map(({ name }) => name), [
    `${PACKAGES}/data.rest.use-thing`,
    `${PACKAGES}/ui.missing`,
    `${PACKAGES}/widgets.thing-view`,
  ]);
  const thing = packageNamed(catalogue, 'data.rest.use-thing');
  assert.equal(thing.version, '5.0.2');
  assert.equal(thing.dir, path.join('hydrogen', 'data', 'rest', 'use-thing'));
  assert.deepEqual(exportsOf(thing), { useThing: 'value' });
  assert.deepEqual(endpointKeys(thing), ['GET /v1/things/list']);
  assert.deepEqual(thing.importers.map(({ from, file }) => [from, file]), [
    [`${PACKAGES}/widgets.thing-view`, path.join('hydrogen', 'widgets', 'thing-view', 'index.ts')],
  ]);
  assert.deepEqual(packageNamed(catalogue, 'ui.missing').exports, []);
});

test('hydrogen catalogue reuse', { skip: TS_ABSENT }, async (t) => {
  const builtAt = (home) => catalogueOf(home, 'app-one').meta;
  await t.test('an unchanged tree skips the rebuild', () => {
    const { home, app } = makeApp();
    assert.equal(run(home, app).status, 0);
    const first = builtAt(home);
    assert.equal(run(home, app).status, 0);
    assert.deepEqual(builtAt(home), first);
  });

  await t.test('a second edit to an already-edited file rebuilds again', () => {
    const { home, app } = makeApp();
    const file = path.join(app, 'node_modules', PACKAGES, 'both-pkg', 'both.ts');
    assert.equal(run(home, app).status, 0);
    const first = builtAt(home);

    fs.writeFileSync(file, "export const both = () => client.put('/v1/both-edited');\n");
    assert.equal(run(home, app).status, 0);
    const second = builtAt(home);
    assert.notEqual(second.key, first.key);
    assert.deepEqual(endpointKeys(packageNamed(catalogueOf(home, 'app-one'), 'both-pkg')), ['PUT /v1/both-edited']);

    fs.writeFileSync(file, "export const both = () => client.put('/v1/both-edited-again');\n");
    assert.equal(run(home, app).status, 0);
    assert.notEqual(builtAt(home).key, second.key);
    assert.deepEqual(endpointKeys(packageNamed(catalogueOf(home, 'app-one'), 'both-pkg')), ['PUT /v1/both-edited-again']);
  });

  await t.test('an app source file change rebuilds', () => {
    const { home, app } = makeApp();
    assert.equal(run(home, app).status, 0);
    const first = builtAt(home);
    fs.writeFileSync(path.join(app, 'src', 'pages', 'home.tsx'), 'export const Home = 1;\n');
    assert.equal(run(home, app).status, 0);
    assert.notEqual(builtAt(home).key, first.key);
    assert.deepEqual(packageNamed(catalogueOf(home, 'app-one'), 'src-pkg').importers.map(({ from }) => from), [`${PACKAGES}/consumer-pkg`]);
  });

  await t.test('a changed script rebuilds', () => {
    const { home, app } = makeApp();
    const copy = path.join(freshDir('script'), 'hydrogen-catalogue.cjs');
    fs.copyFileSync(SCRIPT, copy);
    assert.equal(run(home, app, copy).status, 0);
    const first = builtAt(home);
    assert.equal(run(home, app, copy).status, 0);
    assert.deepEqual(builtAt(home), first);

    fs.appendFileSync(copy, '\n// edited\n');
    assert.equal(run(home, app, copy).status, 0);
    assert.notEqual(builtAt(home).key, first.key);
  });
});

test('hydrogen catalogue failures', async (t) => {
  await t.test('an app with no Hydrogen packages exits non-zero and names the stage', () => {
    const home = freshDir('home');
    const app = path.join(home, 'apps', 'plain');
    put(app, 'node_modules/react/package.json', '{}');
    const result = run(home, app);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /discover packages: no Hydrogen packages found/);
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'state')));
  });

  await t.test('a missing target exits non-zero', () => {
    const home = freshDir('home');
    const result = run(home, path.join(home, 'nowhere'));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /discover packages: .* does not exist/);
  });

  await t.test('no argument exits non-zero', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /read arguments/);
  });

  await t.test('a first build without typescript names the load stage', () => {
    const home = freshDir('home');
    const app = path.join(home, 'apps', 'app-one');
    put(app, 'node_modules/@additiv-hydrogen/pkg/index.ts', 'export const x = 1;\n');
    const env = { ...process.env, HOME: home };
    delete env.HYDROGEN_TS;
    const result = spawnSync(process.execPath, [SCRIPT, app], { encoding: 'utf8', env });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /load typescript: no typescript/);
  });
});
