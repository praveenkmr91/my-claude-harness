#!/usr/bin/env node
// PostToolUse(Edit|Write): warns when an edit ADDS comment lines — makes the
// CLAUDE.md "comments default ZERO / footgun bar" rule fire at write time.
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  const ti = input.tool_input || {};
  const file = ti.file_path || '';
  if (!/\.(ts|tsx|js|jsx|mjs|css|scss|swift|kt|sh)$/.test(file)) return;
  const count = (s) =>
    (s || '').split('\n').filter((l) => /^\s*(\/\/(?!\/)|\/\*|\*\s|#(?!!)|<!--)/.test(l)).length;
  const added = input.tool_name === 'Write'
    ? count(ti.content)
    : count(ti.new_string) - count(ti.old_string);
  if (added < 2) return;
  const context =
    `comment-check: this ${input.tool_name.toLowerCase()} added ${added} comment lines to ${file.split('/').pop()}. ` +
    `CLAUDE.md bar: ZERO by default — keep only lines naming a constraint the code cannot show (a footgun a future reader trips on). ` +
    `Re-read each added comment now; delete the ones that label blocks, restate code, or justify the change to a reviewer.`;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }));
});
