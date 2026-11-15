'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./helpers/block-dangerous-git');

test('block dangerous git hook: hidden', async (t) => {
  await t.test('a dangerous git command is denied wherever it hides', () => {
    for (const command of [
      'git push',
      'git commit -m x && git push origin main',
      'git commit -m "$(git push)"',
      'git commit -m "x" `git push`',
      'bash -c "git push"',
      'echo "a -m "; git push; echo ""',
      'git commit -m x;git push',
      'git commit -m "x\\"" ; git push ; echo "y"',
      'git commit -m x\ngit push',
      'git commit -m x#;git push',
      'git reset --hard HEAD~1',
      'git commit --no-verify -m x',
      'git -C /tmp/x push',
      'git -c user.name=x push origin main',
      'git --git-dir=.git push',
      '/usr/bin/git push',
      'FOO=1 git push',
      'sudo -u me git push',
      'xargs -I {} git push',
      'cd repo && git -C . push --force',
      'sh -c "git -C x push"',
      'eval git push',
      'bash <<EOF\ngit push\nEOF',
      'git clean -xfd',
      'git branch -D feature',
      'git checkout -- .',
      'git -C repo restore .',
      'echo "unbalanced; git push',
      'git commit -m "x `git branch -D feat`"',
    ]) {
      assert.equal(run(command).status, 2, command);
    }
  });
});
