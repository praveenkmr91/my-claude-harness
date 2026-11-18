#!/usr/bin/env python3
"""Read-only plan-churn measurement over Claude Code main-session transcripts."""
import collections
import glob
import itertools
import json
import os
import re
import sys

SINCE = "2026-10-29"
PLAN_RE = re.compile(r"/plans/[^/]+\.md$")
MIN_CALLS = 5
fresh = itertools.count(1)


def new_line(text, count=0):
    return [text, next(fresh), count]


def matches_plan(path):
    return bool(PLAN_RE.search(path)) and not path.endswith(".research.md")


def load_calls(path):
    """Return (calls, results): calls in transcript order, results {tool_use_id: is_error}."""
    calls = []
    results = {}
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if '"tool_use"' not in line and '"tool_result"' not in line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            kind = obj.get("type")
            if kind not in ("assistant", "user"):
                continue
            content = (obj.get("message") or {}).get("content")
            if not isinstance(content, list):
                continue
            for item in content:
                if not isinstance(item, dict):
                    continue
                if kind == "assistant" and item.get("type") == "tool_use" and item.get("name") in ("Edit", "Write"):
                    inp = item.get("input") or {}
                    fp = inp.get("file_path", "")
                    ts = obj.get("timestamp", "")
                    if isinstance(fp, str) and matches_plan(fp) and ts[:10] >= SINCE:
                        calls.append({"id": item.get("id"), "name": item["name"], "input": inp, "ts": ts})
                elif kind == "user" and item.get("type") == "tool_result":
                    results[item.get("tool_use_id")] = bool(item.get("is_error"))
    return calls, results


def section_at(state, idx):
    for i in range(idx, -1, -1):
        if state[i][0].startswith("## "):
            return state[i][0][3:].strip()
    return "(top)"


def apply_edit(state, inp):
    """Return (new_state, section) or None when old_string is not found."""
    old = inp.get("old_string", "")
    new = inp.get("new_string", "")
    if not old:
        return None
    text = "\n".join(l[0] for l in state)
    if inp.get("replace_all"):
        spans = []
        pos = text.find(old)
        while pos != -1:
            spans.append((pos, pos + len(old)))
            pos = text.find(old, pos + len(old))
    else:
        pos = text.find(old)
        spans = [(pos, pos + len(old))] if pos != -1 else []
    if not spans:
        return None

    starts = [0]
    for ch_i, ch in enumerate(text):
        if ch == "\n":
            starts.append(ch_i + 1)

    def line_of(char_idx):
        return text.count("\n", 0, char_idx)

    # (first line, last line) per span; the span's last matched char decides the last line,
    # a matched terminating newline belongs to the line it terminates.
    ranges = [(line_of(s), line_of(e - 1)) for s, e in spans]
    section = section_at(state, ranges[0][0])

    # merge spans whose line ranges touch or overlap into groups
    groups = []
    for (a, b), span in zip(ranges, spans):
        if groups and a <= groups[-1]["b"]:
            groups[-1]["b"] = max(groups[-1]["b"], b)
            groups[-1]["spans"].append(span)
        else:
            groups.append({"a": a, "b": b, "spans": [span]})

    def seg_text(a, b):
        lo = starts[a]
        hi = starts[b + 1] if b + 1 < len(starts) else len(text)
        return lo, hi

    out = []
    cursor = 0
    for g in groups:
        a, b = g["a"], g["b"]
        while True:
            lo, hi = seg_text(a, b)
            pieces = []
            at = lo
            for s, e in g["spans"]:
                pieces.append(text[at:s])
                pieces.append(new)
                at = e
            pieces.append(text[at:hi])
            seg_new = "".join(pieces)
            seg_old = text[lo:hi]
            had_term = seg_old.endswith("\n")
            if had_term and not seg_new.endswith("\n") and b + 1 < len(starts):
                b += 1
                continue
            break
        new_texts = (seg_new[:-1] if had_term and seg_new.endswith("\n") else seg_new).split("\n")
        old_lines = state[a:b + 1]
        out.extend(state[cursor:a])
        for i, t in enumerate(new_texts):
            if i < len(old_lines):
                out.append([t, old_lines[i][1], old_lines[i][2] + 1])
            else:
                out.append(new_line(t, 1))
        cursor = b + 1
    out.extend(state[cursor:])
    return out, section


def replay_pair(calls, results):
    """calls: all matching calls for one (session, plan). Returns stats dict."""
    stats = {"applied": 0, "rejected": 0, "unreplayed": 0, "writes": 0,
             "sections": collections.Counter(), "reverts": [], "state": None, "stamps": []}
    state = None
    for c in calls:
        rid = c["id"]
        if rid not in results or results[rid]:
            stats["rejected"] += 1
            continue
        stats["stamps"].append(c["ts"])
        if c["name"] == "Write":
            state = [new_line(t) for t in c["input"].get("content", "").split("\n")]
            stats["applied"] += 1
            stats["writes"] += 1
            stats["sections"]["(whole-file)"] += 1
        else:
            res = apply_edit(state, c["input"]) if state is not None else None
            if res is None:
                stats["unreplayed"] += 1
                continue
            state, section = res
            stats["applied"] += 1
            stats["sections"][section] += 1
        for l in state:
            if l[0].startswith("#") and "revert" in l[0].lower() and l[0] not in stats["reverts"]:
                stats["reverts"].append(l[0])
    stats["state"] = state
    return stats


def decided_bullets(state):
    found = []
    section = None
    for text, _lid, count in state or []:
        if text.startswith("## "):
            section = text
        elif text.startswith("- ") and section is not None and section.startswith("## Decided"):
            found.append((count, text))
    return found


def main():
    pattern = os.path.expanduser("~/.claude/projects/*/*.jsonl")
    files = sorted(
        f for f in glob.glob(pattern)
        if "/subagents/" not in f and not os.path.basename(f).startswith("agent-")
    )
    pairs = []
    for f in files:
        calls, results = load_calls(f)
        by_plan = collections.OrderedDict()
        for c in calls:
            by_plan.setdefault(c["input"]["file_path"], []).append(c)
        for plan, plan_calls in by_plan.items():
            st = replay_pair(plan_calls, results)
            pairs.append((f, plan, st, results))

    printable = [p for p in pairs if p[2]["applied"] + p[2]["unreplayed"] >= MIN_CALLS]
    printable.sort(key=lambda p: p[2]["applied"] + p[2]["unreplayed"], reverse=True)

    for f, plan, st, _ in printable:
        sid = os.path.basename(f)[:-len(".jsonl")][:8]
        stamps = sorted(st["stamps"])
        span = f"{stamps[0][:10]}..{stamps[-1][:10]}" if stamps else "n/a"
        bullets = decided_bullets(st["state"])
        heavy = sorted((b for b in bullets if b[0] >= 5), key=lambda b: -b[0])
        print(f"{sid} | {plan} | {span}")
        print(f"  total applied: {st['applied']}   rejected: {st['rejected']}   "
              f"unreplayed: {st['unreplayed']}   whole-file writes: {st['writes']}")
        print("  by section: " + (", ".join(f"{k}={v}" for k, v in st["sections"].most_common()) or "none"))
        print(f"  Decided bullets edited 5+ times: {len(heavy)}")
        for count, text in heavy:
            print(f"     {count}x  {text[:100]}")
        print(f"  max edits on any single Decided bullet: {max((b[0] for b in bullets), default=0)}")
        print("  headings containing \"revert\": " + (" ; ".join(st["reverts"]) or "none"))
        print()

    tot = lambda k: sum(p[2][k] for p in pairs)
    print(f"summary: transcripts scanned={len(files)} pairs found={len(pairs)} printed={len(printable)} "
          f"applied={tot('applied')} rejected={tot('rejected')} unreplayed={tot('unreplayed')}")

    if printable:
        f, plan, st, _ = printable[0]
        replay = st["applied"] + st["unreplayed"]
        simple = simple_count(f, plan)
        print(f"crosscheck: replay={replay} simple={simple}")


def simple_count(path, plan):
    """Independent pass: plain count of non-rejected matching calls, no replay."""
    ok_ids, bad_ids, uses = set(), set(), []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            if "tool_use" not in raw and "tool_result" not in raw:
                continue
            try:
                o = json.loads(raw)
            except ValueError:
                continue
            msg = o.get("message")
            body = msg.get("content") if isinstance(msg, dict) else None
            if not isinstance(body, list):
                continue
            for it in body:
                if not isinstance(it, dict):
                    continue
                if it.get("type") == "tool_result":
                    (bad_ids if it.get("is_error") is True else ok_ids).add(it.get("tool_use_id"))
                if o.get("type") == "assistant" and it.get("type") == "tool_use" and it.get("name") in ("Edit", "Write"):
                    fp = (it.get("input") or {}).get("file_path", "")
                    if fp == plan and o.get("timestamp", "")[:10] >= SINCE:
                        uses.append(it.get("id"))
    return sum(1 for u in uses if u in ok_ids and u not in bad_ids)


if __name__ == "__main__":
    main()
    sys.exit(0)
