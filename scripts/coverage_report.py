#!/usr/bin/env python3
"""Report which branches, statements, and functions a test run never reaches.

Coverage percentages do not answer the question that matters before a refactor:
which paths are untested? This script runs Vitest coverage scoped to the requested
sources (or reads an existing ``coverage-final.json`` via ``--input``) and lists
every zero-hit branch **path** with its own source line, so a reader never has to
guess which arm of an ``if`` went unexercised.

Examples:
    python3 scripts/coverage_report.py src/tools/agent/action-dispatch.ts \\
        --tests test/tools/agent-tool.test.ts test/tools/e2e
    python3 scripts/coverage_report.py 'src/modules/sandbox/*.ts' --tests test/modules/sandbox
    python3 scripts/coverage_report.py --input coverage-final.json src/tools/agent/action-dispatch.ts
    python3 scripts/coverage_report.py src/tui/inline-editor.ts --format json

Narrow ``--tests`` deliberately: Vitest instruments only what the selected tests
load, so a broad target list with a narrow suite reports files as never loaded,
and the full suite is the slowest option.
"""

from __future__ import annotations

import argparse
import fnmatch
import functools
import json
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence


@dataclass(frozen=True)
class PathGap:
    """One zero-hit branch path, reported with the source it would have run."""

    line: int
    text: str


@dataclass(frozen=True)
class Gap:
    """An uncovered branch, statement, or function."""

    kind: str
    detail: str
    line: int
    counts: tuple[int, ...]
    text: str
    paths: tuple[PathGap, ...] = ()

    @property
    def sort_key(self) -> tuple[int, int]:
        order = {"branch": 0, "statement": 1, "function": 2}
        return (order[self.kind], self.line)


@dataclass
class FileCoverage:
    """Gap list plus summary counters for one instrumented source file."""

    path: str
    statements_total: int = 0
    statements_covered: int = 0
    branches_total: int = 0
    branches_paths: int = 0
    branches_paths_covered: int = 0
    functions_total: int = 0
    functions_covered: int = 0
    gaps: list[Gap] = field(default_factory=list)

    @property
    def branches_percent(self) -> float:
        if self.branches_paths == 0:
            return 100.0
        return 100.0 * self.branches_paths_covered / self.branches_paths

    @property
    def statements_percent(self) -> float:
        if self.statements_total == 0:
            return 100.0
        return 100.0 * self.statements_covered / self.statements_total

    @property
    def functions_percent(self) -> float:
        if self.functions_total == 0:
            return 100.0
        return 100.0 * self.functions_covered / self.functions_total


def _percent(numerator: int, denominator: int) -> str:
    if denominator == 0:
        return "n/a"
    return f"{100.0 * numerator / denominator:.1f}%"


def source_text(source_root: Path, path: str, line: int) -> str:
    """Return the trimmed source line, or a marker when it cannot be resolved."""

    lines = _source_lines(source_root, path)
    if line < 1 or line > len(lines):
        return "<source unavailable>"
    return lines[line - 1].strip()


@functools.lru_cache(maxsize=None)
def _source_lines(source_root: Path, path: str) -> tuple[str, ...]:
    try:
        return tuple((source_root / path).read_text().splitlines())
    except OSError:
        return ()


def _locations(entry: dict[str, Any]) -> list[int]:
    """Return one line per branch path, tolerating the synthetic nulls V8 emits.

    V8-backed reports occasionally carry `{ line: null }` locations for desugared
    branches (getters, optional chaining), so an absent line becomes 0 and renders as
    an unresolvable source marker rather than crashing the report.
    """

    lines: list[int] = []
    for location in entry.get("locations", []):
        start = location.get("start") or {}
        lines.append(int(start.get("line") or 0))
    return lines


def collect_file(source_root: Path, key: str, file_data: dict[str, Any]) -> FileCoverage:
    """Translate one istanbul file record into a FileCoverage gap list.

    Istanbul keys its maps by id rather than using arrays, and ``branchMap`` entries
    expose ``locations`` instead of a single line, so both are read through helpers.
    """

    path = _relative(source_root, file_data.get("path") or key)
    coverage = FileCoverage(path=path)
    counts = file_data.get("s", {})
    coverage.statements_total = len(counts)
    coverage.statements_covered = sum(1 for value in counts.values() if value)
    for sid, value in counts.items():
        if value:
            continue
        statement = file_data["statementMap"][sid]
        line = int((statement.get("start") or {}).get("line") or 0)
        coverage.gaps.append(Gap("statement", "", line, (), source_text(source_root, path, line)))

    function_counts = file_data.get("f", {})
    coverage.functions_total = len(function_counts)
    coverage.functions_covered = sum(1 for value in function_counts.values() if value)
    for fid, value in function_counts.items():
        if value:
            continue
        entry = file_data["fnMap"][fid]
        origin = entry.get("decl") or entry.get("loc") or {}
        line = int((origin.get("start") or {}).get("line") or 0)
        coverage.gaps.append(
            Gap(
                "function",
                entry.get("name") or "<anonymous>",
                line,
                (),
                source_text(source_root, path, line),
            )
        )

    branch_counts = file_data.get("b", {})
    for entry_id, values in branch_counts.items():
        entry = file_data["branchMap"][entry_id]
        path_lines = _locations(entry)
        coverage.branches_total += 1
        coverage.branches_paths += len(values)
        coverage.branches_paths_covered += sum(1 for value in values if value)
        if all(value for value in values):
            continue
        first_line = path_lines[0] if path_lines else 0
        coverage.gaps.append(
            Gap(
                "branch",
                entry.get("type") or "<unknown>",
                first_line,
                tuple(values),
                source_text(source_root, path, first_line),
                tuple(
                    PathGap(line, source_text(source_root, path, line))
                    for count, line in zip(values, path_lines)
                    if not count
                ),
            )
        )

    coverage.gaps.sort(key=lambda gap: gap.sort_key)
    return coverage


def _relative(source_root: Path, raw_path: str) -> str:
    resolved = Path(raw_path).resolve()
    try:
        return str(resolved.relative_to(source_root.resolve()))
    except ValueError:
        return str(raw_path)


def read_report(report_file: Path, source_root: Path, patterns: Sequence[str]) -> list[FileCoverage]:
    data = json.loads(report_file.read_text())
    selected: list[FileCoverage] = []
    for key, file_data in data.items():
        path = _relative(source_root, file_data.get("path") or key)
        if patterns and not any(fnmatch.fnmatch(path, pattern) for pattern in patterns):
            continue
        selected.append(collect_file(source_root, key, file_data))
    selected.sort(key=lambda item: (len(item.gaps), item.path), reverse=True)
    return selected


def run_vitest_coverage(
    source_root: Path,
    include: Sequence[str],
    tests: Sequence[str],
    reports_dir: Path,
) -> int:
    """Instrument ``include`` targets with Vitest and write a JSON report."""

    command = [
        "npx",
        "vitest",
        "run",
        "--coverage",
        f"--coverage.include={','.join(include)}",
        "--coverage.reporter=json",
        f"--coverage.reportsDirectory={reports_dir}",
        *tests,
    ]
    print(f"$ {' '.join(command)}", file=sys.stderr)
    return subprocess.run(command, cwd=source_root).returncode


def _gap_line(gap: Gap) -> str:
    if gap.kind == "branch":
        counts = ",".join(str(value) for value in gap.counts)
        head = f"  branch  {gap.detail:<12s} L{gap.line:<5d} path hits [{counts}]"
    elif gap.kind == "statement":
        head = f"  stmt    L{gap.line:<5d}"
    else:
        head = f"  fn      {gap.detail} L{gap.line}"
    return f"{head:<44s} | {gap.text}"


def render_text(coverages: Sequence[FileCoverage], top: int, source_root: Path) -> str:
    lines: list[str] = ["Coverage gaps", "-------------"]
    if not coverages:
        lines.append("No instrumented files matched the requested targets.")
        lines.append("")
        lines.append("Nothing was instrumented: check the targets against the selected tests.")
        return "\n".join(lines)

    totals = FileCoverage(path="all")
    for coverage in coverages:
        totals.statements_total += coverage.statements_total
        totals.statements_covered += coverage.statements_covered
        totals.branches_total += coverage.branches_total
        totals.branches_paths += coverage.branches_paths
        totals.branches_paths_covered += coverage.branches_paths_covered
        totals.functions_total += coverage.functions_total
        totals.functions_covered += coverage.functions_covered
        totals.gaps.extend(coverage.gaps)

    lines.append("")
    lines.append(
        "  ".join(
            [
                f"{len(coverages)} file(s)",
                f"branches {_percent(totals.branches_paths_covered, totals.branches_paths)}"
                f" ({totals.branches_paths_covered}/{totals.branches_paths} paths)",
                f"statements {_percent(totals.statements_covered, totals.statements_total)}",
                f"functions {_percent(totals.functions_covered, totals.functions_total)}",
            ]
        )
    )

    for coverage in coverages:
        lines.append("")
        lines.append(
            f"{coverage.path}  branches "
            f"{_percent(coverage.branches_paths_covered, coverage.branches_paths)}"
            f"  statements {_percent(coverage.statements_covered, coverage.statements_total)}"
            f"  functions {_percent(coverage.functions_covered, coverage.functions_total)}"
        )
        if not coverage.gaps:
            lines.append("  no uncovered paths")
            continue
        shown = coverage.gaps if top <= 0 else coverage.gaps[:top]
        for gap in shown:
            lines.append(_gap_line(gap))
            for zero_path in gap.paths:
                if zero_path.line == gap.line:
                    continue
                lines.append(f"  {'':<9s}uncovered path L{zero_path.line}: {zero_path.text}")
        if len(shown) < len(coverage.gaps):
            lines.append(f"  ... {len(coverage.gaps) - len(shown)} more (raise --top)")
    return "\n".join(lines)


def render_json(coverages: Sequence[FileCoverage]) -> str:
    payload = {
        "files": [
            {
                "path": coverage.path,
                "branchesPercent": round(coverage.branches_percent, 2),
                "statementsPercent": round(coverage.statements_percent, 2),
                "functionsPercent": round(coverage.functions_percent, 2),
                "gaps": [
                    {
                        "kind": gap.kind,
                        "detail": gap.detail,
                        "line": gap.line,
                        "counts": list(gap.counts),
                        "text": gap.text,
                        "uncoveredPaths": [{"line": p.line, "text": p.text} for p in gap.paths],
                    }
                    for gap in coverage.gaps
                ],
            }
            for coverage in coverages
        ]
    }
    return json.dumps(payload, indent=2)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("targets", nargs="*", help="source files or globs (repo-relative)")
    parser.add_argument("--tests", nargs="*", default=["test"], help="Vitest file or directory patterns to run")
    parser.add_argument("--input", type=Path, help="existing coverage-final.json to analyze instead of running Vitest")
    parser.add_argument("--reports-dir", type=Path, help="where to write the Vitest coverage report")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--top", type=int, default=30, help="max gaps per file (0 for all)")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    parser.add_argument("--fail-on", choices=("none", "gaps", "thin"), default="none")
    parser.add_argument("--min-branches", type=float, default=80.0, help="branch-path floor for --fail-on thin")
    args = parser.parse_args(argv)

    source_root = args.root.resolve()
    if not args.targets and not args.input:
        parser.error("provide at least one target, or --input with existing report data")

    patterns = [str(target) for target in args.targets] or ["*"]
    owned_reports_dir = args.reports_dir is None
    reports_dir = args.reports_dir or Path(tempfile.mkdtemp(prefix="pi-coverage-"))
    report_file = args.input or reports_dir / "coverage-final.json"

    if args.input is None:
        code = run_vitest_coverage(source_root, patterns, args.tests or ["test"], reports_dir)
        if code != 0:
            print(
                f"Vitest exited {code}; gaps below may be incomplete (report: {report_file})",
                file=sys.stderr,
            )

    if not report_file.exists():
        print(f"no coverage JSON at {report_file}", file=sys.stderr)
        return 1

    coverages = read_report(report_file, source_root, patterns)
    missing = set(patterns) - {coverage.path for coverage in coverages}
    if missing:
        for pattern in sorted(missing):
            if not any(fnmatch.fnmatch(pattern, coverage.path) for coverage in coverages):
                print(f"not instrumented by the selected tests: {pattern}", file=sys.stderr)

    print(render_text(coverages, args.top, source_root) if args.format == "text" else render_json(coverages))
    print(f"\nreport JSON: {report_file}", file=sys.stderr)

    if args.fail_on == "gaps" and any(coverage.gaps for coverage in coverages):
        return 1
    if args.fail_on == "thin" and any(
        coverage.branches_percent < args.min_branches for coverage in coverages
    ):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
