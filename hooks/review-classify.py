# Hook JSON on stdin (it may also carry review_base, the sha before a builder step, and review_scope=report for a REPORT, both set by done-claim-gate.sh), <review-joins> line out. done-claim-gate.sh parses verb=, lenses=, code-added=, required= and owed-files= — keep those keys.
# required= is the only clearing path: a write to a code file outside TEST_FILE_ANY is cleared for a member by a finished, non-errored main-thread run of that member started after the write and shown the file; every run up to this call counts. code-reviewer is owed at 20+ uncleared lines, silent-failure-hunter and type-design-analyzer at 20+ when their own uncleared web text holds their signal, and those two plus placement-analyzer and adversarial-reviewer when the 20+ reach 200 or a path is high-risk; security-review is owed at 20+ lines only with a high-risk path. security-review runs as a main-thread Skill call, the rest as agents. review_scope=report lists only the members the Big rule owes. owed-files= names each owed member's uncleared files.
import functools
import glob
import json
import locale
import os
import re
import shutil
import subprocess
import sys
import urllib.parse

try:
    locale.setlocale(locale.LC_ALL, '')
except locale.Error:
    pass
UTF8_LOCALE = locale.nl_langinfo(locale.CODESET) == 'UTF-8'


def rx(pattern, flags=0):
    return re.compile(pattern, flags if UTF8_LOCALE else flags | re.ASCII)


# Stated forms only: a bare level word also reads "high-risk", "low priority", "--max-findings".
EFFORT_STATED = rx(r'\beffort[ =:]+(low|medium|x?high|max)\b|\b(low|medium|x?high|max)[ -]effort\b|\b(review|battery|harden|trim|audit|verify) (low|medium|x?high|max)([\s.,;:!?]|$)', re.I)
EFFORT_LEVEL = rx(r'low|medium|x?high|max', re.I)
PR_ASK = rx(r'\b(check|review)(ing)? (out |over )?(the |my |this |that |a )?(PR|pull request)s?\b|github\.com/[^ ]+/pull/[0-9]+', re.I)
PR_URL = rx(r'https://github\.com/\S+/pull/[0-9]+')
PR_NUMBER = rx(r'\b(?:PR|pull request) ?#?([0-9]+)', re.I)
DIFF_HEADER = rx(r'^diff --git a/.* b/(.*)$')
WEB_FILE = rx(r'\.(ts|tsx|js|jsx|mjs|cjs|vue)$')
TEST_PATH = rx(r'\.(test|spec)\.|__tests__/|^tests/')
SOURCE_FILE = rx(r'\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|swift|kt|kts|dart)$')
NOT_RISK_SOURCE = rx(r'\.(test|spec)\.|__tests__/|(^|/)tests?/|(^|/)mocks/|__mocks__/')
REACT_FILE = rx(r'\.(tsx|jsx)$|/use-[a-z0-9-]+\.ts$')
STYLE_FILE = rx(r'\.(css|scss|less|sass)$')
STYLE_TEXT = rx(r'className=|[\s:]class=|[\s:]style=|@apply|css`|\ssx=')
TESTABLE_FILE = rx(r'\.(ts|tsx|js|jsx|vue)$')
TEST_FILE_ANY = rx(r'\.(test|spec)\.|__tests__/|(^|/)tests?/')
CAMEL_JOIN = re.compile(r'([a-z0-9])([A-Z])')
TOKENS_DIR = re.compile(r'(^|/)tokens/')
RISK = re.compile(r'(^|[^a-z0-9])(o?auth|authentic[a-z]*|authori[sz][a-z]*|session|tokens?|(re)?payments?|checkout|orders?|wallet)([^a-z0-9]|$)')
RISK_EXEMPT = re.compile(r'design-tokens|tokens?\.(css|scss|less)$')
NUMSTAT_ADDED = re.compile(r'[ \t]*([0-9]+)(?:[ \t]|$)')
# The comment-only patterns come from awk, which matches bytes here whatever the locale.
BLANK = re.compile(r'^\s*$', re.ASCII)
LEADING_SPACE = re.compile(r'^\s+', re.ASCII)
JSX_CLOSE = re.compile(r'^\}\s*$', re.ASCII)
CLOSING_COMMENT = re.compile(r'\*/\}?\s*$', re.ASCII)
DIRECTIVE_COMMENT = re.compile(r'eslint-|oxlint-|@ts-|@type|@vitest-|<reference|prettier-ignore|istanbul|webpackChunkName|@vite-ignore|__PURE__')
SILENT_FAILURE = rx(r'catch\s*[({]|\.catch\(|\?\?|\|\|\s*(null|undefined|\[\]|\{\}|0|false)(\W|$)')
TYPE_DECLARATION = rx(r'^\s*(export\s+)?(declare\s+)?(type|interface|enum|(abstract\s+)?class)\s+[A-Z]')
COMMENT_LINE = rx(r'^\s*(//|/\*|\*)')
LEGACY_SYNTAX = rx(r'(^|[^.\w$])var\s|\.indexOf\([^)]*\)\s*[!=<>]=*\s*-1|Object\.assign\(\s*\{\}|\.apply\(\s*(this|null)|\.substr\(|(^|[^.\w$])require\(')
# Content signals read non-test web code only: Swift/Kotlin `var` and test-fixture strings trip the patterns.
CODE_PATHSPEC = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.vue', ':!*.test.*', ':!*.spec.*', ':!**/__tests__/**', ':!tests/**']
BIG_MEMBERS = ('silent-failure-hunter', 'type-design-analyzer', 'placement-analyzer', 'adversarial-reviewer', 'security-review')
OWED_MEMBERS = ('code-reviewer',) + BIG_MEMBERS
SKILL_MEMBERS = ('security-review',)


def run(program, *args):
    try:
        done = subprocess.run((program,) + args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except OSError:
        return '', False
    if done.returncode != 0:
        return '', False
    return done.stdout.decode('utf-8', 'surrogateescape'), True


def chomp(text):
    return text.rstrip('\n')


def sort_unique(lines):
    # strcoll, not strxfrm: macOS strxfrm raises on U+00C5 and U+212B.
    return sorted(set(lines), key=functools.cmp_to_key(lambda a, b: locale.strcoll(a, b) or (a > b) - (a < b)))


def read_payload():
    text = sys.stdin.buffer.read().decode('utf-8', 'replace').lstrip('﻿').lstrip(' \t\n\r')
    try:
        payload, _ = json.JSONDecoder().raw_decode(text)
    except ValueError:
        return {}
    return payload if isinstance(payload, dict) else {}


def field(payload, *keys):
    value = payload
    for key in keys:
        value = value.get(key) if isinstance(value, dict) else None
    return chomp(value) if isinstance(value, str) else ''


def effort_level(prompt):
    for line in prompt.split('\n'):
        stated = EFFORT_STATED.search(line)
        if stated:
            level = EFFORT_LEVEL.search(stated.group()).group().lower()
            return 'high' if level in ('xhigh', 'max') else level
    return ''


def result_text(result):
    if isinstance(result, list):
        result = '\n'.join(item['text'] for item in result if isinstance(item, dict) and isinstance(item.get('text'), str))
    return result if isinstance(result, str) else ''


def pr_target(prompt_lines):
    for line in prompt_lines:
        url = PR_URL.search(line)
        if url:
            return url.group()
    for line in prompt_lines:
        number = PR_NUMBER.search(line)
        if number:
            return number.group(1)
    return ''


def scan_transcript(top, main):
    top = os.path.realpath(top)
    # Default macOS volumes ignore case; elsewhere two spellings differing in case are two paths.
    fold = str.lower if sys.platform == 'darwin' else str
    NEEDLE = re.compile(rb'"name":"(?:Write|Edit|MultiEdit|Agent|Task|Skill)"|"is_error":true')
    RESULT_ID = re.compile(rb'"tool_use_id":"([^"]+)"')
    NOTICE = re.compile(r'<tool-use-id>([^<]+)</tool-use-id>.*?<status>([a-z]+)</status>', re.S)
    BACKGROUND_NOTE = 'Async agent launched successfully'
    # Twin of `agent_id` in done-claim-gate.sh, narrowed to a filename-safe id.
    AGENT_ID = re.compile(r'agentId: ([A-Za-z0-9_-]+)')
    # Twin of `code` in done-claim-gate.sh.
    CODE = re.compile(r'\.(jsx?|tsx?|mjs|cjs|vue|svelte|css|scss|html|swift|kt|dart|sh|py)\b')
    WEB = re.compile(r'\.(ts|tsx|js|jsx|mjs|cjs|vue)$')
    WORKTREE_PREFIX = re.compile(r'^\.claude/worktrees/[^/]+/')
    agent_dir = os.path.splitext(main)[0] + '/subagents'
    subagents = glob.escape(agent_dir)
    agent_members = tuple(member for member in OWED_MEMBERS if member not in SKILL_MEMBERS)

    def member_of(name, inp):
        by_skill = name == 'Skill'
        kind = ((inp.get('skill') if by_skill else inp.get('subagent_type')) or '').rsplit(':', 1)[-1]
        return kind if name in ('Agent', 'Task', 'Skill') and kind in (SKILL_MEMBERS if by_skill else agent_members) else ''

    since = ''
    calls = []
    failed = set()
    agent_ids = {}
    # A reviewer's result and a background run's notification carry no NEEDLE marker, so they are found by call id.
    reviewers = set()
    answered = set()
    background = set()
    completed = set()
    # A failed or stopped background run resumed through SendMessage reports `completed` under the SendMessage's call id.
    resumed = {}

    def answers_reviewer(raw):
        return bool(reviewers) and b'"tool_result"' in raw and any(call_id.decode() in reviewers for call_id in RESULT_ID.findall(raw))

    for path in [main] + sorted(glob.glob(subagents + '/agent-*.jsonl')):
        is_main = path == main
        try:
            f = open(path, 'rb')
        except OSError:
            continue
        with f:
            for raw in f:
                hit = NEEDLE.search(raw) or (is_main and (b'agentId: ' in raw or b'<task-notification>' in raw or b'"name":"SendMessage"' in raw or answers_reviewer(raw)))
                if not (hit or (is_main and not since)):
                    continue
                try:
                    rec = json.loads(raw)
                except ValueError:
                    continue
                if is_main and not since:
                    since = rec.get('timestamp') or ''
                content = (rec.get('message') or {}).get('content')
                if is_main:
                    attachment = rec.get('attachment')
                    notice = content if isinstance(content, str) else attachment.get('prompt') if isinstance(attachment, dict) else None
                    if isinstance(notice, str) and notice.lstrip().startswith('<task-notification>'):
                        notified = NOTICE.search(notice)
                        if notified and notified.group(2) == 'completed':
                            completed.add(resumed.get(notified.group(1), notified.group(1)))
                        continue
                if not (hit and isinstance(content, list)):
                    continue
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if rec.get('type') == 'user' and block.get('type') == 'tool_result':
                        call_id = block.get('tool_use_id')
                        if block.get('is_error'):
                            failed.add(call_id)
                        elif is_main:
                            text = result_text(block.get('content'))
                            found = AGENT_ID.findall(text)
                            if found and isinstance(call_id, str):
                                agent_ids[call_id] = found[-1]
                            if call_id in reviewers:
                                answered.add(call_id)
                                if BACKGROUND_NOTE in text:
                                    background.add(call_id)
                    elif rec.get('type') == 'assistant' and block.get('type') == 'tool_use':
                        calls.append((rec.get('timestamp') or '', block.get('name'), block.get('input') or {}, block.get('id'), is_main))
                        if is_main and member_of(block.get('name'), block.get('input') or {}):
                            reviewers.add(block.get('id'))
                        if is_main and block.get('name') == 'SendMessage':
                            origin = next((original for original, agent_id in agent_ids.items() if original in reviewers and agent_id == (block.get('input') or {}).get('to')), None)
                            if origin:
                                resumed[block.get('id')] = origin
    runs = {member: [] for member in OWED_MEMBERS}
    for ts, name, inp, call_id, is_main in calls:
        member = member_of(name, inp) if is_main else ''
        if member and call_id in answered and call_id not in failed and (call_id not in background or call_id in completed):
            runs[member].append((ts, call_id))

    # What the reviewer was shown: its own replies and tool results. The brief, its copies in api-request-blob
    # and the harness attachments (injected docs, git status) are not.
    @functools.cache
    def reviewer_text(agent_id):
        shown = []
        try:
            with open('%s/agent-%s.jsonl' % (agent_dir, agent_id), 'rb') as f:
                for raw in f:
                    if not (b'"type":"assistant"' in raw or (b'"type":"user"' in raw and b'"tool_result"' in raw)):
                        continue
                    try:
                        rec = json.loads(raw)
                    except ValueError:
                        continue
                    content = (rec.get('message') or {}).get('content')
                    if rec.get('type') == 'assistant':
                        shown.append(json.dumps(content, ensure_ascii=False))
                    elif rec.get('type') == 'user' and isinstance(content, list):
                        shown += [result_text(block.get('content')) for block in content if isinstance(block, dict) and block.get('type') == 'tool_result']
        except OSError:
            return None
        return '\n'.join(shown).encode('utf-8', 'replace')

    # A run with no linked or readable transcript clears as before; a change in the wording of the
    # result's `agentId:` line would silently turn this check off.
    @functools.cache
    def clears_file(call_id, rel):
        agent_id = agent_ids.get(call_id)
        text = reviewer_text(agent_id) if agent_id else None
        # A file written inside a worktree is keyed `.claude/worktrees/<name>/src/…` once the session
        # leaves it, while its reviewer names it `src/…`; match on the path inside its own checkout.
        own = WORKTREE_PREFIX.sub('', rel)
        return text is None or not os.path.exists(top + '/' + rel) or own.encode('utf-8', 'surrogateescape') in text

    def cleared(ts, rel, member_points):
        return any(ts <= point_ts and clears_file(call_id, rel) for point_ts, call_id in member_points)

    edited = {}
    lines = {member: {} for member in OWED_MEMBERS}
    texts = {member: [] for member in OWED_MEMBERS}
    # The impeccable join reads every commit since the session began, so one styled edit would owe an
    # audit on every later claim; once an audit has run, only styling written after it owes another.
    audits = [ts for ts, name, inp, call_id, is_main in calls if is_main and name == 'Skill' and (inp.get('skill') or '').rsplit(':', 1)[-1] == 'impeccable' and call_id not in failed]
    restyled = None if not audits else False
    for ts, name, inp, call_id, is_main in calls:
        file_path = inp.get('file_path')
        if name not in ('Write', 'Edit', 'MultiEdit') or not file_path:
            continue
        path = os.path.realpath(file_path)
        if fold(path[:len(top) + 1]) == fold(top + '/'):
            path = top + path[len(top):]
        edited[path] = None
        if call_id in failed or not path.startswith(top + '/'):
            continue
        rel = path[len(top) + 1:]
        new = [inp.get('content'), inp.get('new_string')] + [e.get('new_string') for e in inp.get('edits') or []]
        new = [s for s in new if isinstance(s, str)]
        if audits and ts > audits[-1] and not TEST_FILE_ANY.search(rel) and (STYLE_FILE.search(rel) or any(STYLE_TEXT.search(s) for s in new)):
            restyled = True
        if not CODE.search(rel):
            continue
        written = sum(len(s.splitlines()) for s in new)
        if written and not TEST_FILE_ANY.search(rel):
            for member in OWED_MEMBERS:
                if cleared(ts, rel, runs[member]):
                    continue
                lines[member][rel] = lines[member].get(rel, 0) + written
                if WEB.search(rel):
                    texts[member] += new
    return str(since), '\n'.join(edited), lines, {member: '\n'.join(member_texts) for member, member_texts in texts.items()}, restyled


def log_since(since, flags, pathspec):
    if not since:
        return ''
    return run('git', 'log', *flags, '--pretty=format:', '--since=' + since, '--', *pathspec)[0]


def untracked_files(pathspec):
    listing = run('git', 'ls-files', '--others', '--exclude-standard', '-z', '--', *pathspec)[0]
    return [path for path in listing.split('\0') if path]


def read_bytes(path):
    try:
        with open(path, 'rb') as f:
            return f.read()
    except OSError:
        return b''


def count_newlines(path):
    try:
        with open(path, 'rb') as f:
            return sum(chunk.count(b'\n') for chunk in iter(lambda: f.read(1 << 20), b''))
    except OSError:
        return 0


def has_test_script(top):
    try:
        package = json.loads(read_bytes(top + '/package.json').decode('utf-8', 'replace'))
    except ValueError:
        return False
    scripts = package.get('scripts') if isinstance(package, dict) else None
    test = scripts.get('test') if isinstance(scripts, dict) else None
    return isinstance(test, str) and test != '' and 'no test specified' not in test


# Repo-agnostic on purpose; this runs in every repo. Whole-word match after a camelCase split —
# bare substrings flag author/, recorder.ts and design tokens, silently upgrading review to harden.
# Risk reads source paths only: docs, manifests, specs and mocks never carry it, and a tokens/ directory is no credential.
def high_risk(files):
    risky = []
    for path in files:
        if not SOURCE_FILE.search(path) or NOT_RISK_SOURCE.search(path):
            continue
        folded = TOKENS_DIR.sub('/', CAMEL_JOIN.sub(r'\1-\2', path)).lower()
        if RISK.search(folded) and not RISK_EXEMPT.search(folded):
            risky.append(path)
    return ''.join(path + ' ' for path in risky[:5])


def big_owed(member_paths):
    member_lines = sum(member_paths.values())
    return member_lines >= 20 and (member_lines >= 200 or high_risk(member_paths))


def member_owed(member, paths, text, report_scope):
    if sum(paths.values()) < 20:
        return False
    if member == 'code-reviewer':
        return not report_scope
    if member == 'security-review':
        return bool(high_risk(paths))
    return big_owed(paths) or (not report_scope and member in signals(text))


def signals(text):
    lines = text.split('\n')
    found = []
    if any(SILENT_FAILURE.search(line) for line in lines):
        found.append('silent-failure-hunter')
    if any(TYPE_DECLARATION.search(line) for line in lines):
        found.append('type-design-analyzer')
    if sum(1 for line in lines if COMMENT_LINE.search(line)) >= 3:
        found.append('comment-analyzer')
    if any(LEGACY_SYNTAX.search(line) for line in lines):
        found.append('modern-ts-analyzer')
    return found


# Comment-only exit: lines are judged alone, never by block state. Directive comments (lint, ts, build hints) change tool output, so they count as code.
def comment_only(diff_text):
    changed = 0
    code = 0
    for line in diff_text.split('\n'):
        if line[:1] not in ('+', '-') or line.startswith(('+++ ', '--- ')):
            continue
        text = line[1:]
        changed += 1
        if DIRECTIVE_COMMENT.search(text):
            code += 1
            continue
        if BLANK.search(text):
            continue
        text = LEADING_SPACE.sub('', text)
        if text.startswith('//'):
            continue
        if text.startswith('/*') or text.startswith('{/*'):
            jsx = text.startswith('{')
            rest = text[3 if jsx else 2:]
            end = rest.find('*/')
            if end < 0:
                continue
            after = rest[end + 2:]
            if BLANK.search(after) or (jsx and JSX_CLOSE.search(after)):
                continue
            code += 1
            continue
        if '/*' not in text and '=' not in text and '(' not in text and CLOSING_COMMENT.search(text):
            continue
        code += 1
    return changed > 0 and code == 0


def classify(payload):
    transcript = field(payload, 'transcript_path')
    edited = ''
    prompt = field(payload, 'prompt')
    base = field(payload, 'review_base')
    report_scope = field(payload, 'review_scope') == 'report'
    effort = effort_level(prompt)
    no_scope = '<review-joins effort=%s>' % effort if effort else None

    # A named PR replaces session scope: a colleague's PR has no edits here and a clean tree.
    pr = ''
    pr_diff = ''
    prompt_lines = prompt.split('\n')
    if any(PR_ASK.search(line) for line in prompt_lines) and shutil.which('gh'):
        pr = pr_target(prompt_lines)
        pr_diff = chomp(run('gh', 'pr', 'diff', *([pr] if pr else []))[0])

    top = None
    ref = 'HEAD'
    since = ''
    member_lines = {}
    member_texts = {}
    restyled = None
    scoped = ''
    untracked = ''
    scope = []
    scope_code = []
    if pr_diff:
        names = []
        for line in pr_diff.split('\n'):
            header = DIFF_HEADER.match(line)
            if header:
                names.append(header.group(1))
        files = chomp('\n'.join(sort_unique(names)))
    else:
        if not run('git', 'rev-parse', '--is-inside-work-tree')[1]:
            return no_scope
        top = chomp(run('git', 'rev-parse', '--show-toplevel')[0])
        if transcript and os.access(transcript, os.R_OK):
            try:
                since, scanned, member_lines, member_texts, restyled = scan_transcript(top, transcript)
            except Exception:
                since, scanned, member_lines, member_texts, restyled = '', '', {}, {}, None
            edited = chomp(scanned)
        # Steps amend into one commit, so --since cannot isolate a step, and the step window outranks session edits.
        if base and run('git', 'cat-file', '-e', base + '^{commit}')[1]:
            ref = base
            since = ''
            edited = ''
        # The dirty tree often carries another task's in-flight work; it is scope only when this session edited nothing here.
        prefix = top + '/'
        scoped = chomp('\n'.join(sort_unique([line[len(prefix):] for line in edited.split('\n') if line.startswith(prefix)])))
        # Pathspecs for the git reads below. An empty pathspec means the whole tree, so a scoped run with no
        # code files must skip the content read rather than pass an empty list.
        if scoped:
            try:
                os.chdir(top or '.')
            except OSError:
                return None
            files = scoped
            scope = scoped.split('\n')
            scope_code = [path for path in scope if path and WEB_FILE.search(path) and not TEST_PATH.search(path)]
        else:
            committed = chomp(run('git', 'log', '--name-only', '--pretty=format:', '--since=' + since)[0]) if since else ''
            names = committed.split('\n') + run('git', 'diff', '--name-only', ref)[0].split('\n') + run('git', 'ls-files', '--others', '--exclude-standard')[0].split('\n')
            files = '\n'.join(sort_unique([name for name in names if name]))
        untracked = run('git', 'ls-files', '--others', '--exclude-standard', '--', *scope)[0]
    if not files:
        return no_scope
    file_lines = files.split('\n')

    react = 'yes' if any(REACT_FILE.search(line) for line in file_lines) else 'no'
    risk = high_risk(file_lines)

    # Bulk = over-engineering risk: added lines across committed-this-session + dirty + untracked, new files likewise.
    if pr_diff:
        diff_lines = pr_diff.split('\n')
        added = sum(1 for line in diff_lines if line.startswith('+') and not line.startswith(('+++ b/', '+++ /dev/null')))
        new_files = sum(1 for line in diff_lines if line.startswith('new file mode'))
    else:
        numstat = log_since(since, ['--numstat'], scope) + run('git', 'diff', '--numstat', ref, '--', *scope)[0]
        counted = [NUMSTAT_ADDED.match(line) for line in numstat.split('\n')]
        added = sum(int(found.group(1)) for found in counted if found)
        for path in untracked_files(scope):
            if path.split()[:1] != ['total']:
                added += count_newlines(path)
        new_names = log_since(since, ['--diff-filter=A', '--name-only'], scope) + run('git', 'diff', '--diff-filter=A', '--name-only', ref, '--', *scope)[0] + untracked
        new_files = len(set(name for name in new_names.split('\n') if name))

    verb = 'review'
    lenses = ['reuse-analyzer', 'placement-analyzer']
    if react == 'yes':
        lenses.append('react-best-practices')
    if risk:
        verb = 'harden'
        lenses += ['adversarial-reviewer', 'security-review']
    bulk = 'yes' if added >= 200 or new_files >= 3 else 'no'
    if bulk == 'yes':
        lenses.append('delete-list')

    def lens(member):
        if member not in lenses:
            lenses.append(member)

    if risk and bulk == 'yes':
        lens('code-reviewer')

    if pr_diff:
        added_lines = []
        keep = False
        for line in pr_diff.split('\n'):
            if line.startswith('diff --git '):
                name = re.sub(r'^b/', '', re.findall(r'[^ \t]+', line)[-1])
                keep = bool(WEB_FILE.search(name)) and not TEST_PATH.search(name)
            elif keep and line.startswith('+') and not line.startswith('+++ '):
                added_lines.append(line[1:])
        added_text = chomp('\n'.join(added_lines))
    elif not scope_code and scoped:
        added_text = ''
    else:
        code_spec = scope_code or CODE_PATHSPEC
        patch = log_since(since, ['-p'], code_spec) + run('git', 'diff', ref, '--', *code_spec)[0]
        text = ''.join(line[1:] + '\n' for line in patch.split('\n') if line.startswith('+') and not line.startswith('+++'))
        text += b''.join(read_bytes(path) for path in untracked_files(code_spec)).decode('utf-8', 'replace')
        added_text = chomp(text.replace('\0', ''))
    added_text_lines = added_text.split('\n')

    styled = any(STYLE_FILE.search(line) for line in file_lines) or any(STYLE_TEXT.search(line) for line in added_text_lines)
    if restyled is not None and not pr_diff:
        styled = restyled
    for member in signals(added_text):
        lens(member)
    if styled:
        lens('impeccable')
    package_top = top if top is not None and not scoped else chomp(run('git', 'rev-parse', '--show-toplevel')[0])
    if has_test_script(package_top) and any(TESTABLE_FILE.search(line) for line in file_lines) and not any(TEST_FILE_ANY.search(line) for line in file_lines):
        lens('pr-test-analyzer')

    owed = [member for member in OWED_MEMBERS if member_owed(member, member_lines.get(member, {}), member_texts.get(member, ''), report_scope)]
    required = ','.join(owed) or 'none'
    code_added = sum(member_lines.get('code-reviewer', {}).values())

    if pr_diff:
        diff_text = pr_diff
        untracked = ''
    else:
        diff_text = chomp(log_since(since, ['-p'], scope) + run('git', 'diff', ref, '--', *scope)[0])
        untracked = chomp(untracked)
    if not untracked and comment_only(diff_text):
        verb = 'review'
        lenses = ['comment-analyzer']
        required = 'none'

    entries = []
    for member in OWED_MEMBERS:
        if member in required.split(','):
            ranked = sorted(member_lines[member].items(), key=lambda item: (-item[1], item[0]))
            listed = [urllib.parse.quote(path, safe='/', errors='surrogateescape') for path, _ in ranked[:5]]
            if len(ranked) > 5:
                listed.append('+%d' % (len(ranked) - 5))
            entries.append('%s:%s' % (member, ','.join(listed)))

    return '<review-joins verb=%s lenses=%s react=%s high-risk=%s bulk=%s code-added=%d required=%s added=%d new-files=%d%s%s%s>' % (
        verb, ','.join(lenses), react, risk or 'none', bulk, code_added, required, added, new_files,
        ' pr=%s' % (pr or 'current') if pr_diff else '',
        ' effort=%s' % effort if effort else '',
        ' owed-files=%s' % ';'.join(entries) if entries else '')


try:
    joins = classify(read_payload())
    if joins:
        sys.stdout.buffer.write((joins + '\n').encode('utf-8', 'surrogateescape'))
except Exception as error:
    print(repr(error), file=sys.stderr)
