#!/bin/bash

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

# Tokenized, not substring-matched: quoted text is data, but `git -C dir push`, wrappers, `sh -c`, $(…), backticks and
# heredocs fed to a shell are still found. Unparseable input falls back to a raw substring scan (fail closed).
DANGER=$(python3 -c '
import os, re, shlex, sys

GLOBAL_WITH_ARG = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path"}
WRAPPERS = {"sudo", "env", "command", "nohup", "time", "exec", "xargs", "nice"}
SHELLS = {"bash", "sh", "zsh"}
OPERATOR_CHARS = "();<>|&\n"

def git_danger(argv):
    i = 0
    while i < len(argv) and argv[i].startswith("-"):
        i += 2 if argv[i] in GLOBAL_WITH_ARG else 1
    if i >= len(argv):
        return None
    sub, rest = argv[i], argv[i + 1:]
    if "--no-verify" in rest:
        return "--no-verify"
    if sub == "push":
        return "git push"
    if sub == "reset" and "--hard" in rest:
        return "git reset --hard"
    if sub == "clean" and any(a == "--force" or re.fullmatch(r"-[a-zA-Z]*f[a-zA-Z]*", a) for a in rest):
        return "git clean -f"
    if sub == "branch" and any(re.fullmatch(r"-[a-zA-Z]*D[a-zA-Z]*", a) for a in rest):
        return "git branch -D"
    if sub in ("checkout", "restore") and any(a in (".", "./") for a in rest):
        return f"git {sub} ."
    return None

def segment_danger(words):
    while words and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", words[0]):
        words = words[1:]
    if words and words[0] in WRAPPERS:
        git_at = next((i for i, w in enumerate(words) if os.path.basename(w) == "git"), None)
        words = words[git_at:] if git_at is not None else []
    if not words:
        return None
    program = os.path.basename(words[0])
    if program == "git":
        return git_danger(words[1:])
    if program in SHELLS and "-c" in words[1:-1]:
        return scan(words[words.index("-c") + 1])
    if program == "eval":
        return scan(" ".join(words[1:]))
    return None

def drop_heredoc_bodies(text):
    kept, delimiter = [], None
    for line in text.split("\n"):
        if delimiter is not None:
            if line.strip() == delimiter:
                delimiter = None
            continue
        kept.append(line)
        heredoc = re.search(r"<<-?\s*([\x27\"]?)(\w+)\1", line)
        feeds_shell = re.search(r"(^|[|;&]\s*|\b(sudo|exec)\s+)(bash|sh|zsh)\b", line)
        if heredoc and not feeds_shell:
            delimiter = heredoc.group(2)
    return "\n".join(kept)

def scan(text):
    for inner in re.findall(r"\$\(([^()]*)\)", text) + re.findall(r"`([^`]*)`", text):
        hit = scan(inner)
        if hit:
            return hit
    lexer = shlex.shlex(drop_heredoc_bodies(text), posix=True, punctuation_chars=OPERATOR_CHARS)
    lexer.whitespace, lexer.whitespace_split, lexer.commenters = " \t\r", True, ""
    words = []
    for token in list(lexer) + [";"]:
        if token and set(token) <= set(OPERATOR_CHARS):
            hit = segment_danger(words)
            if hit:
                return hit
            words = []
        else:
            words.append(token)
    return None

try:
    print(scan(sys.argv[1]) or "")
except Exception:
    sys.exit(3)
' "$COMMAND") || DANGER=$(echo "$COMMAND" | grep -oE 'git push|reset --hard|git clean -f|git branch -D|git (checkout|restore) \.|--no-verify' | head -1)

# Push is allowed only to a whitelisted remote: personal backups Praveen owns alone, pushed with every commit.
# Every `-C <dir>` in the command must point at a whitelisted repo; with none, the session cwd must. A wrapper, subshell,
# eval or heredoc can hide a `-C` to another repo behind a whitelisted cwd, so those stay blocked regardless. Wrapper
# words count only at command position: a pathspec like `hooks/foo.sh` or a commit message must not trip the filter.
PUSH_WHITELIST='github\.com[:/]praveenkmr91/my-claude-harness(\.git)?$'
SESSION_CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
whitelisted_repo() {
  local dir=${1/#\~/$HOME}
  case "$dir" in /*) ;; *) dir="$SESSION_CWD/$dir" ;; esac
  git -C "$dir" remote get-url origin 2>/dev/null | grep -qE "$PUSH_WHITELIST"
}
WRAPPER_AT_COMMAND_POSITION='(^|[;&|(`]|\$\()[[:space:]]*(cd|pushd|sh|bash|zsh|eval|exec|xargs|sudo|env|nohup|time|nice|command)([[:space:]]|$)|\$\(|`|<<'
if [ "$DANGER" = "git push" ] && ! printf '%s' "$COMMAND" | grep -qE "$WRAPPER_AT_COMMAND_POSITION"; then
  REPO_DIRS=$(printf '%s' "$COMMAND" | grep -oE '(^|[;&| (])git -C [^ ]+' | awk '{print $NF}')
  [ -n "$REPO_DIRS" ] || REPO_DIRS=$SESSION_CWD
  ALLOWED=1
  for d in $REPO_DIRS; do whitelisted_repo "$d" || ALLOWED=0; done
  [ -n "$REPO_DIRS" ] && [ "$ALLOWED" = 1 ] && DANGER=""
fi

if [ "$DANGER" = "--no-verify" ]; then
  echo "BLOCKED: Do not pass --no-verify. husky/lint-staged are part of the verify gate; if a hook is genuinely broken, surface it to the user instead of skipping it." >&2
  exit 2
elif [ -n "$DANGER" ]; then
  echo "BLOCKED: '$COMMAND' runs '$DANGER'. The user has prevented you from doing this." >&2
  exit 2
fi

ARG='("[^"]*"|'\''[^'\'']*'\''|[^[:space:]]+)'
GIT_COMMIT='\bgit([[:space:]]+(-[Cc]|--git-dir|--work-tree|--namespace|--config-env)[[:space:]]+'"$ARG"'|[[:space:]]+--?[a-zA-Z][^[:space:]]*)*[[:space:]]+commit\b'
GH_PR='\bgh([[:space:]]+(-R|--repo)[[:space:]]+'"$ARG"'|[[:space:]]+--?[a-zA-Z][^[:space:]]*)*[[:space:]]+pr[[:space:]]+'

GUARDED=(
  '\bcp\b[^|;&]*node_modules/::Do not cp out of node_modules. Check package.json scripts for an eject/copy command first — a hand-copied file silently goes stale on the next install.'
  '\brm\b[^|;&]*(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)::Do not delete a lockfile to clean it. Regenerating re-pins every ^/~ range to today registry (silent toolchain drift). Remove the single stanza by hand, or run npm install --package-lock-only.'
  "$GIT_COMMIT"'[[:space:]]+(--all\b|-[a-z]*a[a-z]*\b)::Do not commit with -a/--all. Use an explicit pathspec (git commit --only <paths>) so unrelated in-flight work in the tree is left untouched.'
  'git add[[:space:]]+(-[a-zA-Z]*A[a-zA-Z]*\b|--all\b|\.(/)?([[:space:]]|$))::Do not bulk-stage. git add -A/--all/. sweeps unrelated in-flight work and untracked debris into the commit. Run git status --short, then stage only your files: git add -- <path> <path>, or commit them directly with git commit --only -m "<msg>" -- <path> <path>. Never retry with -u, :/ or a directory that holds others'\'' changes.'
)

# zsh aborts an unquoted --include=*.tsx with "no matches found" before grep runs, so quote it rather than block.
GLOB_FLAG='--(include|exclude|exclude-dir)=([^'\''"\\[:space:]]*[][*?][^'\''"[:space:]]*)'
QUOTED=$COMMAND
if printf '%s' "$COMMAND" | grep -qE '\bgrep\b[^|;&]*'"$GLOB_FLAG"; then
  QUOTED=$(printf '%s' "$COMMAND" | sed -E "s/$GLOB_FLAG/--\\1='\\2'/g")
fi

for entry in "${GUARDED[@]}"; do
  pattern="${entry%%::*}"
  message="${entry#*::}"
  if echo "$COMMAND" | grep -qE "$pattern"; then
    echo "BLOCKED: $message" >&2
    exit 2
  fi
done

if echo "$COMMAND" | grep -qE "$GIT_COMMIT|${GH_PR}(create|edit)\b" \
  && echo "$COMMAND" | perl -pe 's/co-authored-by:[^<"\n]*<[^>@\s]+\@additiv\.com>//gi' | grep -qiE 'co-authored-by|generated with|🤖'; then
  echo "BLOCKED: attribution trailer in a commit/PR message. The user forbids Co-Authored-By (except a teammate's @additiv.com address), 'Generated with', and tool footers everywhere (~/.claude/committing.md). Rewrite the message without it — do not copy trailers from existing commits in git log." >&2
  exit 2
fi

DECISION='{}'
if echo "$COMMAND" | grep -qE "${GH_PR}create\b"; then
  DECISION='{"permissionDecision":"ask","permissionDecisionReason":"A PR is published to others and needs your yes (committing.md: push and PR need a yes)."}'
fi

# No permissionDecision with the rewrite: the quoted command still goes through permission rules and the classifier.
if [ "$QUOTED" != "$COMMAND" ] || [ "$DECISION" != '{}' ]; then
  echo "$INPUT" | jq --arg cmd "$QUOTED" --argjson decision "$DECISION" '{hookSpecificOutput: ({hookEventName: "PreToolUse"} + $decision
    + (if .tool_input.command == $cmd then {} else {updatedInput: (.tool_input + {command: $cmd})} end))}'
fi

exit 0
