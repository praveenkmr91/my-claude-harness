'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpDir, env } = require('./done-claim-gate');

const stamp = (seconds = 0) => new Date(Date.UTC(2099, 0, 1, 0, 0, seconds)).toISOString();
const sourceLines = (count, first = 'export const v0 = 0;') => [first, ...Array.from({ length: count - 1 }, (_, i) => `export const v${i + 1} = ${i + 1};`)].join('\n') + '\n';
const withCatch = 'try { run(); } catch (e) { report(e); }';
const CLAIM = 'Done: the edits landed.';
const ASK = 'Diff is above.\nSay yes and I will commit.';
const NOT_RUN = /REVIEW AGENTS NOT RUN/;

const scratchRepo = () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmpDir, 'repo-')));
  spawnSync('git', ['init', '-q'], { cwd: repo, env });
  return repo;
};
const writeOf = (repo, file, content, timestamp) => ({ blocks: [{ type: 'tool_use', id: `write-${file}`, name: 'Write', input: { file_path: path.join(repo, file), content } }], timestamp });
const dispatchOf = (member, timestamp, id = `dispatch-${member}`, answered = true) => ({ blocks: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: member, description: 'review', prompt: 'review', effort: 'low' } }], timestamp, answered });
const skillOf = (skill, timestamp, id = `skill-${skill}`, answered = true) => ({ blocks: [{ type: 'tool_use', id, name: 'Skill', input: { skill } }], timestamp, answered });
const resultOf = (id, isError, timestamp, text = 'out') => ({ record: { type: 'user', timestamp, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] } } });
const checked = (timestamp) => ({ command: 'pnpm lint && node --test tests/*.test.js', output: 'ℹ fail 0', timestamp });
const committed = (timestamp) => ({ command: 'git commit -m x', output: '', timestamp });
const shipped = (timestamp) => ({ command: 'git rm docs/plans/demo.md && git commit -m ship', output: '', timestamp });
const feedbackOf = (text) => ({ record: { type: 'user', isMeta: true, message: { content: `Stop hook feedback:\n[bash …/done-claim-gate.sh]: ${text}` } } });
const agentFeedback = () => feedbackOf('REVIEW AGENTS NOT RUN for code-reviewer: source written in this session still owes each a run.');
const opts = (repo, extra) => ({ cwd: repo, since: stamp(0), lint: false, editedFile: null, ...extra });
const blocked = (res, members) => {
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, new RegExp(`REVIEW AGENTS NOT RUN for ${members}:`));
};
const quiet = (res) => {
  assert.doesNotMatch(res.stderr, NOT_RUN);
  assert.equal(res.status, 0, res.stderr);
};

const AGENT_MEMBERS = ['code-reviewer', 'silent-failure-hunter', 'type-design-analyzer', 'placement-analyzer', 'adversarial-reviewer'];
const BIG_MEMBERS = AGENT_MEMBERS.slice(1);
const ALL_NAMES = AGENT_MEMBERS.join(', ');
const BIG_NAMES = BIG_MEMBERS.join(', ');
const allRuns = (timestamp, without) => AGENT_MEMBERS.filter((member) => member !== without).map((member) => dispatchOf(member, timestamp));
const bigDispatches = (timestamp, without) => BIG_MEMBERS.filter((member) => member !== without).map((member) => dispatchOf(member, timestamp));
const SIX_NAMES = `${ALL_NAMES}, security-review`;
const landed = (timestamp) => ({ ...committed(timestamp), output: '[master abc1234] x' });

module.exports = {
  stamp,
  sourceLines,
  withCatch,
  CLAIM,
  ASK,
  NOT_RUN,
  scratchRepo,
  writeOf,
  dispatchOf,
  skillOf,
  resultOf,
  checked,
  committed,
  shipped,
  landed,
  feedbackOf,
  agentFeedback,
  opts,
  blocked,
  quiet,
  AGENT_MEMBERS,
  ALL_NAMES,
  BIG_NAMES,
  SIX_NAMES,
  allRuns,
  bigDispatches,
};
