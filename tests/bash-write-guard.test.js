'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'bash-write-guard.js');

const SCRATCH = '/private/tmp/claude-501/proj/session/scratchpad';

function run(command, cwd = '/Users/me/repo') {
  const res = spawnSync('node', [HOOK_PATH], { input: JSON.stringify({ cwd, tool_input: { command } }), encoding: 'utf8' });
  return { code: res.status, stderr: res.stderr };
}

test('bash write guard', async (t) => {
  const blocked = [
    ['heredoc into a component', "cat > $d/referral-code.tsx <<'EOF'\nexport const A = 1;\nEOF"],
    ['heredoc behind mkdir', "mkdir -p packages/x && cat > packages/x/package.json <<'EOF'\n{}\nEOF"],
    ['append redirect', 'echo "row,1" >> roboinvest-mb.csv'],
    ['quoted redirect target', 'printf "x" > "docs/plan.md"'],
    ['csv heredoc', "cat > EmployeePortal.csv <<'EOF'\nkey,value\nEOF"],
    ['tee', 'echo x | tee -a src/index.ts'],
    ['python heredoc write', "python3 - <<'EOF'\nfrom pathlib import Path\nPath('docs/layout.md').write_text('x')\nEOF"],
    ['python heredoc taking file args', "FILES=$(git grep -l x -- src); python3 - ${=FILES} <<'EOF'\nimport sys\nfor p in sys.argv[1:]:\n    open(p,'w').write(open(p).read().replace('a','b'))\nEOF\ngrep -c x src/locale.ts"],
    ['node module-mode inline write',"node --input-type=module -e \"import fs from 'fs'; fs.writeFileSync('src/a.ts', '')\""],
    ['node inline write',"node -e \"require('fs').writeFileSync('src/a.ts', '')\""],
    ['python edit through a resolved variable', "python3 - <<'EOF'\np='packages/a/index.ts'; s=open(p).read()\nopen(p,'w').write(s.replace('a','b'))\nEOF"],
    ['python edit through an unresolved parameter', "python3 - <<'EOF'\nimport pathlib\ndef sub(p,old,new):\n    f=pathlib.Path(p); f.write_text(f.read_text().replace(old,new))\nsub('src/init.spec.ts','a','b')\nEOF"],
    ['stage in scratch then copy in', `cat > ${SCRATCH}/x.tsx <<'EOF'\nx\nEOF\ncp ${SCRATCH}/x.tsx src/x.tsx`],
    ['copy from scratch into a directory', 'cp /tmp/x.tsx src/components/'],
    ['move an extensionless scratch file onto a dotfile', `S=${SCRATCH}/npmrc.restore; { echo x; } > $S && mv $S /Users/me/repo/.npmrc`],
    ['copy an oddly named scratch file onto a source file', `cp ${SCRATCH}/staged.txt src/a.ts`],
    ['python shutil copy into the repo', "python3 -c \"import shutil; shutil.copy('/tmp/x.ts', 'src/x.ts')\""],
    ['dotfile append', "printf 'dist/\\n' >> .gitignore"],
    ['harness doc heredoc', "cat > ~/.claude/CLAUDE.md <<'EOF'\nhi\nEOF"],
    ['project notes outside memory/', 'echo x > ~/.claude/projects/p/notes.md'],
    ['relative write after cd into the repo', `cd ${SCRATCH} && cd /Users/me/repo && echo x > src/a.ts`],
    ['node argv destination resolved to a repo file', ['node -e \'require("fs").writeFileSync(process.argv[1], "x")\' src/app.ts', 'src/app.ts']],
    ['python argv destination resolved to a home path', ['python3 -c \'import sys; open(sys.argv[1], "w").write("x")\' $HOME/repo/a.json', 'repo/a.json']],
    ['node argv index out of range with a guarded path in the command', ['node -e \'require("fs").writeFileSync(process.argv[3], "x")\' a src/x.ts', 'src/x.ts']],
    ['node argv destination from an unexpanded variable', ['node -e \'require("fs").writeFileSync(process.argv[1], "x")\' $UNSET/a.json', 'a.json']],
    ['redirect inside a bash -c payload', 'bash -c "echo x > src/a.ts"'],
    ['redirect inside a sh -c payload', "sh -c 'cat a > src/b.ts'"],
    ['redirect inside an eval payload', 'eval "echo x > src/a.ts"'],
    ['redirect inside a double-quoted command substitution', 'echo "$(cat a > src/x.ts)"'],
    ['redirect inside double-quoted backticks', 'git commit -m "`cat a > src/x.ts`"'],
  ];
  for (const [name, entry] of blocked) {
    const [command, listed] = [entry].flat();
    await t.test(`blocks ${name}`, () => {
      const res = run(command);
      assert.equal(res.code, 2);
      assert.match(res.stderr, /Use Write or Edit/);
      if (listed) assert.ok(res.stderr.includes(listed), res.stderr);
    });
  }

  const planEdits = [
    ['sed -i on a repo plan', "sed -i '' 's/a/b/' docs/plans/holdings.md"],
    ['perl -pi on a repo plan', "perl -pi -e 's/a/b/' /Users/me/repo/docs/plans/holdings.md"],
    ['perl -i.bak on a harness plan', "perl -i.bak -pe 's/a/b/' ~/.claude/plans/plan-lint.md"],
    ['git mv into docs/plans', 'git mv /tmp/draft.md docs/plans/draft.md'],
  ];
  for (const [name, command] of planEdits) {
    await t.test(`blocks ${name}`, () => {
      const res = run(command);
      assert.equal(res.code, 2);
      assert.match(res.stderr, /edit plan files with Write or Edit, so plan-lint sees them/);
    });
  }

  const allowed = [
    ['sed -i on a non-plan file', "sed -i '' 's/a/b/' docs/layout.md"],
    ['sed -i one-liner', "sed -i '' 's#a#b#g' packages/core.i18n/package.json"],
    ['git mv', 'git mv packages/a/banner packages/b/banner'],
    ['stderr and null redirects', 'pnpm verify 2>&1 > /dev/null'],
    ['fd duplication', 'echo oops >&2'],
    ['scratchpad output', 'jq . a.json > /private/tmp/claude-501/x/scratchpad/out.json'],
    ['tmp output', 'cat > /tmp/notes.md <<EOF\nx\nEOF'],
    ['arrow in a commit message', 'git commit -m "banner => referral.md"'],
    ['redirect to a non-guarded file', 'pnpm test > test.log'],
    ['csv read via cat', 'cat EmployeePortal.csv'],
    ['python read-only script', "python3 - <<'EOF'\nprint(open('src/a.ts').read())\nEOF"],
    ['python writing only to scratch', "python3 -c \"open('/tmp/x.json','w').write('{}')\""],
    ['python reading source, writing scratch', "python3 -c \"s=open('src/a.ts').read(); open('/tmp/x.json','w').write(s)\""],
    ['scratch alias redirect', `S=${SCRATCH}; jq -c . a.jsonl > $S/cmds.jsonl`],
    ['braced scratch alias', `SP=${SCRATCH} && echo x > "\${SP}/out.md"`],
    ['relative write after cd into scratch', `S=${SCRATCH}; mkdir -p $S && cd $S && echo "$2" > e.js`],
    ['relative write from a scratch session cwd', ['echo x > notes.md', SCRATCH]],
    ['TMPDIR output', 'echo x > $TMPDIR/out.json'],
    ['memory note heredoc', "cat > ~/.claude/projects/-x-y/memory/note.md <<'EOF'\nhi\nEOF"],
    ['memory index append through $HOME', "printf 'x' >> $HOME/.claude/projects/p/memory/MEMORY.md"],
    ['relative memory write after cd', 'cd ~/.claude/projects/p/memory && echo x > note.md'],
    ['redirect text inside a heredoc body', "cat > /tmp/notes.md <<'EOF'\npnpm build > out.json\nEOF"],
    ['git mv of a component', 'git mv src/a.tsx src/b.tsx'],
    ['in-repo mv rename', 'mv src/a.tsx src/b.tsx'],
    ['copy out to scratch', 'cp src/a.tsx /tmp/a.tsx'],
    ['a probe script heredoc-ed into scratch', `S=${SCRATCH}; cat > $S/probe.mjs <<'EOF'\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(OUT + '/tokenRes.json', body);\nEOF`],
    ['commit message describing a python write', `git commit -m "python open(p,'w') edits skipped hooks" && git show --stat settings.json`],
    ['running a script file', 'node scripts/generate-translation-keys.mjs --check'],
    ['restore a scratch backup', 'cp src/init.ts /tmp/init.bak; sed -i "" "/x/d" src/init.ts; pnpm test; cp /tmp/init.bak src/init.ts'],
    ['read-only node script mentioning dot paths', "cd ~/.claude/projects; node -e 'const re=/x/; if (re.test(s)) out.write(s)'"],
    [
      'node argv destination in scratch while the command mentions other files',
      `S=/private/tmp/claude-501/x/scratchpad && grep -v foo CLAUDE.md > $S/CLAUDE.md && node -e 'const fs=require("fs"); const head=require("child_process").execSync("git show HEAD:settings.json",{encoding:"utf8"}); fs.writeFileSync(process.argv[1], head.replace("a","b"))' $S/settings.json && jq empty $S/settings.json`,
    ],
    ['python argv destination in /tmp', 'python3 -c \'import sys; open(sys.argv[1], "w").write("x")\' /tmp/x.json'],
    ['node argv index out of range, sweep fallback finds no guarded path (exit 0)', 'node -e \'require("fs").writeFileSync(process.argv[3], "x")\' a'],
    ['angle brackets in a commit message', 'git commit -m "plan-lint: research moves to <name>.research.md beside the plan"'],
    ['greater-than inside a quoted string', 'echo "a > b.md"'],
    ['tee named in a commit message', 'git commit -m "pipe output through tee notes.md"'],
    ['cp named in a commit message', 'git commit -m "cp /tmp/x.ts src/x.ts was the old flow"'],
    ['empty command', ''],
    ['single-quoted substitution text, never expanded', "echo '$(cat a > src/x.ts)'"],
  ];
  for (const [name, command] of allowed) {
    await t.test(`allows ${name}`, () => assert.equal(run(...[command].flat()).code, 0));
  }

  await t.test('fails open on malformed input', () => {
    const res = spawnSync('node', [HOOK_PATH], { input: 'not json', encoding: 'utf8' });
    assert.equal(res.status, 0);
  });
});
