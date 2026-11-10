#!/usr/bin/env node
// PostToolUse(Write|Edit): warns when an edit ADDS comment lines (code-craft.md "comments
// default ZERO / footgun bar") and when it adds a `shortcut:` marker with no upgrade trigger.
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  const ti = input.tool_input || {};
  const file = ti.file_path || '';
  if (!/\.(tsx?|jsx?|mjs|cjs|mts|cts|sh|vue|svelte|css|scss|swift|kts?|dart)$/.test(file)) return;
  const isShell = file.endsWith('.sh');
  const isCommentLine = (l) => /^\s*(\/\/(?!\/)|\/\*|\*\s|<!--)/.test(l) || (isShell && /^\s*#(?!!)/.test(l));
  const count = (s) => (s || '').split('\n').filter(isCommentLine).length;
  const added = input.tool_name === 'Write'
    ? count(ti.content)
    : count(ti.new_string) - count(ti.old_string);
  const markers = (s) => ((s || '').match(/shortcut:/g) || []).length;
  const addedText = (input.tool_name === 'Write' ? ti.content : ti.new_string) || '';
  const addsMarker = input.tool_name === 'Write'
    ? markers(ti.content) > 0
    : markers(ti.new_string) > markers(ti.old_string);
  const hasTrigger = /\b(?:until|once|when|upgrade|revisit|lands?|replaced?|before)\b/i.test(addedText);
  const name = file.split('/').pop();
  const lines = [];
  if (addsMarker && !hasTrigger) {
    lines.push(
      `comment-check: ${name} adds a shortcut: marker with no upgrade trigger — form is \`shortcut: <limit>, <when to upgrade>\` (until / once / when / before …); add the trigger or drop the marker.`
    );
  }
  if (added >= 2) {
    lines.push(
      `comment-check: this ${input.tool_name.toLowerCase()} added ${added} comment lines to ${name}. ` +
      `code-craft.md bar: ZERO by default — keep only lines naming a constraint the code cannot show (a footgun a future reader trips on). ` +
      `Re-read each added comment now; delete the ones that label blocks, restate code, or justify the change to a reviewer.`
    );
  }
  if (!lines.length) return;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: lines.join('\n') } }));
});
