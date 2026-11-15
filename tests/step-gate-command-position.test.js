'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bash, STEP_DONE, run } = require('./helpers/step-gate');

test('step gate: command position', async (t) => {
  await t.test('a check counts only at command position', () => {
    const counts = (command) => run([...STEP_DONE, bash(command), bash('git commit -m "step 1"')]).code === 0;
    const pairs = [
      ['eslint package.json', 'grep eslint package.json'],
      ['git log; tsc', 'git log --grep tsc'],
      ['npx oxlint .', 'echo npx oxlint .'],
      ['pnpm run check:types', 'pnpm run build'],
      ['cd x && npx tsc --noEmit', 'cd x && ls tsc'],
      ['node --test tests/x.test.js', 'node tests/x.test.js'],
      ['FOO=1 pnpm test', 'FOO=1 pnpm build'],
      ['cd x\nnpx tsc --noEmit', 'cd x\necho "npx tsc"'],
      ['pnpm --filter web lint', 'pnpm --filter web build'],
      ['npx jest', 'echo npx jest'],
      ['pnpm exec jest --ci', 'pnpm exec cat jest.config.js'],
      ['flutter analyze && flutter test', 'flutter pub get'],
      ['./gradlew ktlintCheck', './gradlew assembleDebug'],
      ['xcodebuild -scheme App test', 'xcodebuild -scheme App build'],
      ['swiftlint', 'brew install swiftlint'],
      ['npx ng lint', 'npx ng serve'],
      ['npx nx lint web', 'npx nx graph'],
      ['npx turbo run lint', 'npx turbo run build'],
      ['npx playwright test', 'npx playwright install'],
      ['yarn workspace web lint', 'yarn workspace web start'],
      ['npm t', 'npm i'],
      ['command tsc', 'command ls'],
      ['./gradlew :app:testDebugUnitTest', './gradlew :app:assembleDebug'],
      ['./gradlew connectedAndroidTest', './gradlew -p latest build'],
      ['npx biome check .', 'npx biome format .'],
      ['npx svelte-check', 'npx svelte-kit sync'],
      ['tsc --noEmit', 'tsc --version'],
    ];
    for (const [check, notCheck] of pairs) {
      assert.equal(counts(check), true, check);
      assert.equal(counts(notCheck), false, notCheck);
    }
  });
});
