---
name: patch-hygiene
description: Scripted edits (python/sed) must assert their match counts before writing; silent no-op replacements have twice shipped dead code and a stale reference.
category: Workflow
---

# Scripted edits must assert before they write

`str.replace(old, new)` returns the original string when `old` is absent, and `sed` exits 0 when nothing
matched. Both fail **silently**, and in this repository that has twice produced a file that typechecked and
tested as if the edit had landed:

- A multi-line `s.replace()` in a batch of five edits matched nothing because Prettier had reflowed the target
  a few lines earlier, so one `input.ladder.get(...)` survived a rename to `input.spanLadder` — a runtime
  `TypeError` that only surfaced as a compaction attempt with the detail `Cannot read properties of undefined`.
- A `sed` that renamed a key without the value it wrapped left a test helper folding an appended instruction
  into the span it was supposed to exclude, so two assertions "failed" against a broken fixture.

## Rule

Route every scripted mutation through a helper that asserts the expected count first, and assert the
postcondition after:

```python
def sub(src, old, new, n=1, label=""):
    found = src.count(old)
    assert found == n, f"ABORT [{label or old[:70]!r}]: expected {n}, found {found}"
    return src.replace(old, new)
```

Then re-read the file (or grep the symbol) to prove the change landed — `assert "input.ladder" not in s` is
what would have caught the first case. On failure, abort **without writing**, rather than writing a partial
batch.

## Why it happens here specifically

Long multi-file batches with a final `prettier --write` are the usual shape of the mistake: the format pass
moves the exact text a later patch was matched against. Prefer the `edit` tool for exact-string changes (it
reports a failed match instead of doing nothing), and when a heredoc script is genuinely the right tool, keep
each mutation inside an `sub()`/`assert` so a no-op is loud.
