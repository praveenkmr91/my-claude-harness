#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCOPE = '@additiv-hydrogen';
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const SKIPPED_DIRS = new Set(['node_modules', 'openapi', 'mocks']);
const SKIPPED_FILE = /^handlers\.|\.(?:spec|stories|composition)\./;
const ENDPOINT = /\.(get|post|put|patch|delete)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/g;
const IMPORTER = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]@additiv-hydrogen\/([^'"/]+)[^'"]*['"]/g;
const APP_ENTRIES = ['index.ts', 'index.tsx', 'dist/index.d.ts'];
const VENDORED_SRC = path.join('src', 'core', 'additiv-hydrogen');

function stage(name, fn) {
  try {
    return fn();
  } catch (error) {
    throw new Error(`${name}: ${error.message}`);
  }
}

function walk(dir, { skipDist = false, skipRelative = [] } = {}) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  const visit = (relative) => {
    for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        const skipped =
          SKIPPED_DIRS.has(entry.name) || (skipDist && child === 'dist') || skipRelative.includes(child);
        if (!skipped) visit(child);
      } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !SKIPPED_FILE.test(entry.name)) {
        files.push(child);
      }
    }
  };
  visit('');
  return files.sort();
}

function monorepoPackages(root) {
  const bitmap = fs.readFileSync(path.join(root, '.bitmap'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return Object.values(JSON.parse(bitmap)).map((component) => {
    const mainFile = path.join(component.rootDir, component.mainFile);
    return {
      name: `${SCOPE}/${component.name.replaceAll('/', '.')}`,
      version: component.version,
      dir: component.rootDir,
      entry: fs.existsSync(path.join(root, mainFile)) ? component.mainFile : null,
    };
  });
}

function appPackages(root) {
  const installed = path.join(root, 'node_modules', SCOPE);
  if (!fs.existsSync(installed)) return [];
  return fs
    .readdirSync(installed)
    .filter((folder) => fs.statSync(path.join(installed, folder)).isDirectory())
    .map((folder) => {
      const dir = path.join('node_modules', SCOPE, folder);
      return {
        name: `${SCOPE}/${folder}`,
        version: null,
        dir,
        entry: APP_ENTRIES.find((candidate) => fs.existsSync(path.join(root, dir, candidate))) ?? null,
      };
    });
}

function discover(target) {
  const isMonorepo = target === 'monorepo';
  const root = isMonorepo ? path.join(os.homedir(), 'Documents', 'projects', 'hydrogen') : path.resolve(target);
  if (!fs.existsSync(root)) throw new Error(`${root} does not exist`);
  const packages = isMonorepo ? monorepoPackages(root) : appPackages(root);
  if (packages.length === 0) throw new Error(`no Hydrogen packages found under ${root}`);
  for (const pkg of packages) {
    const hasSourceEntry = pkg.entry !== null && !pkg.entry.startsWith('dist/');
    pkg.files = walk(path.join(root, pkg.dir), { skipDist: hasSourceEntry });
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  const srcFiles = isMonorepo ? [] : walk(path.join(root, 'src'), { skipRelative: [path.relative('src', VENDORED_SRC)] });
  return { label: isMonorepo ? 'monorepo' : path.basename(root), target: isMonorepo ? 'monorepo' : root, isMonorepo, root, packages, srcFiles };
}

function cacheKey({ root, isMonorepo, packages, srcFiles }) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(__filename));
  const files = [];
  if (isMonorepo) files.push(path.join(root, '.bitmap'));
  for (const pkg of packages) {
    if (!isMonorepo) files.push(path.join(root, pkg.dir, 'package.json'));
    for (const file of pkg.files) files.push(path.join(root, pkg.dir, file));
  }
  for (const file of srcFiles) files.push(path.join(root, 'src', file));
  for (const file of files.filter((candidate) => fs.existsSync(candidate))) {
    const { size, mtimeNs } = fs.statSync(file, { bigint: true });
    hash.update(`${file}\t${size}\t${mtimeNs}\n`);
  }
  return hash.digest('hex');
}

function loadTypescript(root) {
  const installed = path.join(root, 'node_modules', 'typescript');
  const location = fs.existsSync(installed) ? installed : process.env.HYDROGEN_TS;
  if (!location) throw new Error(`no typescript in ${root}/node_modules and HYDROGEN_TS is not set`);
  return require(location);
}

function kindOf(ts, checker, symbol) {
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return resolved.flags & ts.SymbolFlags.Value ? 'value' : 'type';
}

function exportsByEntry(ts, root, packages) {
  const entries = packages.filter((pkg) => pkg.entry).map((pkg) => path.join(root, pkg.dir, pkg.entry));
  const program = ts.createProgram(entries, { allowJs: false, jsx: ts.JsxEmit.React, noEmit: true, skipLibCheck: true });
  const checker = program.getTypeChecker();
  return (pkg) => {
    if (!pkg.entry) return [];
    const sourceFile = program.getSourceFile(path.join(root, pkg.dir, pkg.entry));
    const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) return [];
    return checker
      .getExportsOfModule(moduleSymbol)
      .map((symbol) => ({ name: symbol.getName(), kind: kindOf(ts, checker, symbol) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

function endpointsIn(text, file) {
  const found = [];
  for (const match of text.matchAll(ENDPOINT)) {
    const literal = match[2] ?? match[3] ?? match[4];
    if (!literal.includes('/')) continue;
    found.push({
      method: match[1].toUpperCase(),
      path: literal.replace(/\$\{([^}]*)\}/g, '{$1}'),
      file,
      line: lineAt(text, match.index),
    });
  }
  return found;
}

function importedPackages(text) {
  return new Set([...text.matchAll(IMPORTER)].map((match) => `${SCOPE}/${match[1]}`));
}

function scan(site, ts) {
  const { root, packages, srcFiles } = site;
  const exportsOf = exportsByEntry(ts, root, packages);
  const importersByName = new Map(packages.map((pkg) => [pkg.name, []]));
  const recordImporters = (text, from, file) => {
    for (const name of importedPackages(text)) importersByName.get(name)?.push({ from, file });
  };

  const built = packages.map((pkg) => {
    const endpoints = [];
    for (const file of pkg.files) {
      const text = fs.readFileSync(path.join(root, pkg.dir, file), 'utf8');
      endpoints.push(...endpointsIn(text, file));
      recordImporters(text, pkg.name, path.join(pkg.dir, file));
    }
    return { pkg, endpoints };
  });
  for (const file of srcFiles) {
    recordImporters(fs.readFileSync(path.join(root, 'src', file), 'utf8'), 'src', path.join('src', file));
  }

  return built.map(({ pkg, endpoints }) => ({
    name: pkg.name,
    version: pkg.version ?? readVersion(root, pkg.dir),
    dir: pkg.dir,
    entry: pkg.entry,
    exports: exportsOf(pkg),
    endpoints,
    importers: importersByName.get(pkg.name).sort((a, b) => a.from.localeCompare(b.from) || a.file.localeCompare(b.file)),
  }));
}

function readVersion(root, dir) {
  const manifest = path.join(root, dir, 'package.json');
  return fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')).version ?? null : null;
}

function writeAtomically(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

function main() {
  const target = process.argv[2];
  if (!target) throw new Error('read arguments: expected <monorepo | app root>');
  const site = stage('discover packages', () => discover(target));
  const key = stage('compute key', () => cacheKey(site));
  const output = path.join(os.homedir(), '.claude', 'state', 'hydrogen-map', site.label, 'catalogue.json');

  const previous = stage('read previous catalogue', () =>
    fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null
  );
  if (previous?.meta?.key !== key) {
    const ts = stage('load typescript', () => loadTypescript(site.root));
    const packages = stage('build catalogue', () => scan(site, ts));
    const catalogue = { meta: { target: site.target, key, built: new Date().toISOString() }, packages };
    stage('write catalogue', () => writeAtomically(output, JSON.stringify(catalogue)));
  }
  console.log(output);
}

try {
  main();
} catch (error) {
  console.error(`hydrogen-catalogue: ${error.message}`);
  process.exitCode = 1;
}
