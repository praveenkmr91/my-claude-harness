#!/bin/bash

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

# Tokenized, not substring-matched: quoted text is data, but `git -C dir push`, wrappers, `sh -c`, $(…), backticks and
# heredocs fed to a shell are still found. Unparseable input falls back to a raw substring scan (fail closed).
# `git branch -D` passes only for the branch of a worktree removed earlier in the same `&&` chain: git refuses to remove
# a dirty worktree, and the `&&` then stops the delete. `--force` removal frees nothing.
# A session owns a worktree it created: its own transcript holds the Bash call that ran `git worktree add -b <branch>
# <path>`, and git's reflog shows that branch was created within ten minutes after that call. The transcript alone is
# not proof: a call that failed, or never ran behind a `false &&`, is recorded just the same. The owner may
# `git reset --hard` there while that path still has that branch checked out, and may `git branch -D` that branch.
# A `cd`, a wrapper word, a `GIT_DIR`-style variable or a `--git-dir`/`--work-tree` flag hides where a reset lands,
# so those stay blocked; name the worktree with `-C`.
SESSION_CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
DANGER=$(python3 -c '
import json, os, re, shlex, subprocess, sys
from datetime import datetime

GLOBAL_WITH_ARG = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path"}
WRAPPERS = {"sudo", "env", "command", "nohup", "time", "exec", "xargs", "nice"}
SHELLS = {"bash", "sh", "zsh"}
OPERATOR_CHARS = "();<>|&\n"
SESSION_CWD, TRANSCRIPT = sys.argv[2], sys.argv[3]
STATE = {"relocated": bool(re.search(r"\bGIT_(DIR|WORK_TREE|COMMON_DIR)\b", sys.argv[1]))}

def git_call(argv, cwd):
    i, repo, located = 0, cwd, True
    while i < len(argv) and argv[i].startswith("-"):
        if argv[i] == "-C" and i + 1 < len(argv):
            repo = os.path.join(repo, os.path.expanduser(argv[i + 1]))
        elif argv[i] in GLOBAL_WITH_ARG and argv[i] != "-c":
            located = False
        i += 2 if argv[i] in GLOBAL_WITH_ARG else 1
    return (repo, located, argv[i], argv[i + 1:]) if i < len(argv) else None

def added_worktree(repo, args):
    branch, path, i = None, None, 0
    while i < len(args):
        if args[i] == "-b" and i + 1 < len(args):
            branch, i = args[i + 1], i + 2
        else:
            path = path if path or args[i].startswith("-") else args[i]
            i += 1
    return (os.path.realpath(os.path.join(repo, os.path.expanduser(path))), branch) if path and branch else None

def created_worktrees():
    created = set()
    with open(TRANSCRIPT) as lines:
        for line in lines:
            if "worktree" not in line:
                continue
            entry = json.loads(line)
            content = (entry.get("message") or {}).get("content")
            if entry.get("type") != "assistant" or not isinstance(content, list):
                continue
            for block in content:
                if block.get("type") != "tool_use" or block.get("name") != "Bash":
                    continue
                for words, _ in segments((block.get("input") or {}).get("command", "")):
                    call = git_call(words[1:], entry.get("cwd") or SESSION_CWD) if words and os.path.basename(words[0]) == "git" else None
                    added = added_worktree(call[0], call[3][1:]) if call and call[2] == "worktree" and call[3][:1] == ["add"] else None
                    if added:
                        created.add(added + (datetime.fromisoformat(entry["timestamp"].replace("Z", "+00:00")).timestamp(),))
    return created

def git_output(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True).stdout.strip()

def created_by_session(repo, branch, path=None):
    oldest = git_output(repo, "log", "-g", "--date=unix", "--format=%gd %gs", "refs/heads/" + branch, "--").splitlines()[-1:]
    born = re.match(r"\S+@\{(\d+)\} branch: Created from ", oldest[0]) if oldest else None
    return bool(born) and any(
        name == branch and path in (None, made_at) and -2 <= int(born.group(1)) - asked <= 600
        for made_at, name, asked in created_worktrees()
    )

def owns_worktree(repo):
    top, branch = git_output(repo, "rev-parse", "--show-toplevel"), git_output(repo, "symbolic-ref", "--short", "HEAD")
    return bool(top and branch) and created_by_session(repo, branch, os.path.realpath(top))

def worktree_branch(repo, path):
    target = os.path.realpath(os.path.join(repo, os.path.expanduser(path)))
    listing = subprocess.run(["git", "-C", repo, "worktree", "list", "--porcelain"], capture_output=True, text=True).stdout
    for entry in listing.split("\n\n"):
        fields = dict(line.split(" ", 1) for line in entry.splitlines() if " " in line)
        if "worktree" in fields and os.path.realpath(fields["worktree"]) == target:
            return fields.get("branch", "").replace("refs/heads/", "", 1) or None
    return None

def git_danger(argv, freed_branches):
    call = git_call(argv, SESSION_CWD)
    if call is None:
        return None
    repo, located, sub, rest = call
    if "--no-verify" in rest:
        return "--no-verify"
    if sub == "push":
        return "git push"
    if sub == "reset" and "--hard" in rest:
        return None if located and not STATE["relocated"] and owns_worktree(repo) else "git reset --hard"
    if sub == "clean" and any(a == "--force" or re.fullmatch(r"-[a-zA-Z]*f[a-zA-Z]*", a) for a in rest):
        return "git clean -f"
    if sub == "worktree" and rest[:1] == ["remove"] and not {"-f", "--force"} & set(rest):
        paths = [a for a in rest[1:] if not a.startswith("-")]
        branch = worktree_branch(repo, paths[0]) if len(paths) == 1 else None
        if branch:
            freed_branches.add(branch)
    if sub == "branch" and any(re.fullmatch(r"-[a-zA-Z]*D[a-zA-Z]*", a) for a in rest):
        names = {a for a in rest if not a.startswith("-")}
        if not names or not (names <= freed_branches or all(n in freed_branches or created_by_session(repo, n) for n in names)):
            return "git branch -D"
    if sub in ("checkout", "restore") and any(a in (".", "./") for a in rest):
        return f"git {sub} ."
    return None

def segment_danger(words, freed_branches):
    while words and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", words[0]):
        words = words[1:]
    if words and words[0] in WRAPPERS:
        STATE["relocated"] = True
        git_at = next((i for i, w in enumerate(words) if os.path.basename(w) == "git"), None)
        words = words[git_at:] if git_at is not None else []
    if not words:
        return None
    program = os.path.basename(words[0])
    if program in ("cd", "pushd"):
        STATE["relocated"] = True
    if program == "git":
        return git_danger(words[1:], freed_branches)
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
    for inner in re.findall(r"\$\(([^()]*)\)", text) + re.findall(r"`([^`]*)`", text.replace("\\`", "")):
        hit = scan(inner)
        if hit:
            return hit
    freed_branches = set()
    for words, operator in segments(text):
        hit = segment_danger(words, freed_branches)
        if hit:
            return hit
        if operator != "&&":
            freed_branches = set()
    return None

def segments(text):
    lexer = shlex.shlex(drop_heredoc_bodies(text), posix=True, punctuation_chars=OPERATOR_CHARS)
    lexer.whitespace, lexer.whitespace_split, lexer.commenters = " \t\r", True, ""
    words = []
    for token in list(lexer) + [";"]:
        if token and set(token) <= set(OPERATOR_CHARS):
            yield words, token
            words = []
        else:
            words.append(token)

try:
    print(scan(sys.argv[1]) or "")
except Exception:
    sys.exit(3)
' "$COMMAND" "$SESSION_CWD" "$TRANSCRIPT") || DANGER=$(echo "$COMMAND" | grep -oE 'git push|reset --hard|git clean -f|git branch -D|git (checkout|restore) \.|--no-verify' | head -1)

# Push is allowed only to a whitelisted remote: personal backups Praveen owns alone, pushed with every commit.
# Every `-C <dir>` in the command must point at a whitelisted repo; with none, the session cwd must. A wrapper, subshell,
# eval or heredoc can hide a `-C` to another repo behind a whitelisted cwd, so those stay blocked regardless. Wrapper
# words count only at command position: a pathspec like `hooks/foo.sh` or a commit message must not trip the filter.
PUSH_WHITELIST='github\.com[:/]praveenkmr91/my-claude-harness(\.git)?$'
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
  [ "$DANGER" = "git reset --hard" ] && echo "A worktree this session created with 'git worktree add -b' resets as plain 'git -C <worktree> reset --hard <ref>'; anywhere else it stays denied." >&2
  [ "$DANGER" = "git push" ] && echo "A whitelisted backup remote pushes as plain 'git -C <repo> push …'; a cd, subshell or wrapper word at command position is denied regardless." >&2
  exit 2
fi

ARG='("[^"]*"|'\''[^'\'']*'\''|[^[:space:]]+)'
GIT_OPTIONS='([[:space:]]+(-[Cc]|--git-dir|--work-tree|--namespace|--config-env)[[:space:]]+'"$ARG"'|[[:space:]]+--?[a-zA-Z][^[:space:]]*)*'
GIT_COMMIT='\bgit'"$GIT_OPTIONS"'[[:space:]]+commit\b'
GH_PR='\bgh([[:space:]]+(-R|--repo)[[:space:]]+'"$ARG"'|[[:space:]]+--?[a-zA-Z][^[:space:]]*)*[[:space:]]+pr[[:space:]]+'

GUARDED=(
  '\bcp\b[^|;&]*node_modules/::Do not cp out of node_modules. Check package.json scripts for an eject/copy command first — a hand-copied file silently goes stale on the next install.'
  '\brm\b[^|;&]*(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)::Do not delete a lockfile to clean it. Regenerating re-pins every ^/~ range to today registry (silent toolchain drift). Remove the single stanza by hand, or run npm install --package-lock-only.'
  "$GIT_COMMIT"'[[:space:]]+(--all\b|-[a-z]*a[a-z]*\b)::Do not commit with -a/--all. Use an explicit pathspec (git commit --only <paths>) so unrelated in-flight work in the tree is left untouched.'
  '\bgit'"$GIT_OPTIONS"'[[:space:]]+add[[:space:]]+(-[a-zA-Z]*A[a-zA-Z]*\b|--all\b|\.(/)?([[:space:]]|$))::Do not bulk-stage. git add -A/--all/. sweeps unrelated in-flight work and untracked debris into the commit. Run git status --short, then stage only your files: git add -- <path> <path>, or commit them directly with git commit --only -m "<msg>" -- <path> <path>. Never retry with -u, :/ or a directory that holds others'\'' changes.'
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
