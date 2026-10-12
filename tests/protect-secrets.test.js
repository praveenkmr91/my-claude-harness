'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { checkBashCommand } = require(path.resolve(__dirname, '..', 'hooks', 'protect-secrets.js'));

const blocked = (command) => checkBashCommand(command, 'high').blocked;

test('protect-secrets bash reads of .env', async (t) => {
  await t.test('blocks a text tool reading .env, however it is quoted', () => {
    for (const command of [
      'grep API_KEY .env',
      "grep 'API_KEY' .env",
      'grep KEY ".env"',
      "grep KEY '.env'",
      'grep "/tmp/.env"',
      "rg KEY '.env.local'",
      'awk -F= "/KEY/{print}" .env.local',
      "awk -F'=' '{print $2}' .env",
      'grep --include="*.txt" KEY .env',
      'grep -e"API_KEY" .env',
      'grep "a\\"b" .env',
      "rg -g'.env' KEY",
      'cat foo && grep X .env',
      'jq .token config/.env.json',
    ]) {
      assert.equal(blocked(command), true, command);
    }
  });

  await t.test('passes .env named as code, after a separator, or as a template', () => {
    for (const command of [
      'rg "import.meta.env" src',
      'grep -rn import.meta.env src',
      'grep foo && echo .env',
      'grep -c "some text" notes/diagram.svg',
      'grep STRIPE .env.example',
      'grep -rn TODO src/',
    ]) {
      assert.equal(blocked(command), false, command);
    }
  });

  await t.test('stays fast on many quoted arguments that never name .env', () => {
    const command = 'grep -c ' + Array.from({ length: 40 }, (_, i) => `'a${i}' "b${i}"`).join(' ') + ' src';
    const started = process.hrtime.bigint();
    assert.equal(blocked(command), false);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 50, `took ${elapsedMs}ms`);
  });
});
