#!/usr/bin/env python3
"""Produce a compact cognitive-load report from ESLint's JSON formatter.

By default this runs the repository's local ESLint executable, then reports the
built-in ``complexity`` rule and SonarJS's ``sonarjs/cognitive-complexity`` rule.
An existing ESLint JSON report can be supplied with ``--input`` instead, which
is useful for CI artifacts and for making the report without running ESLint a
second time.

Examples:
    python3 scripts/cognitive_load_report.py
    python3 scripts/cognitive_load_report.py --target src/modules --top 20
    python3 scripts/cognitive_load_report.py --big-function-lines 150
    eslint . --format json > eslint.json
    python3 scripts/cognitive_load_report.py --input eslint.json

The structure dimension exists because per-function scores are blind to a long function assembled
from many small callbacks: every callback can stay under the threshold while the reader still holds
the whole thing. The report therefore also asks ESLint for its AST-based max-lines-per-function rule
in the same pass, nests the reported spans, and separates a function's own lines from the lines of the
functions inside it.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable, Sequence

COMPLEXITY_RULE = "complexity"
COGNITIVE_RULE = "sonarjs/cognitive-complexity"
STRUCTURE_RULE = "max-lines-per-function"
RULES = (COMPLEXITY_RULE, COGNITIVE_RULE)
MIN_FUNCTION_LINES_DEFAULT = 20
BIG_FUNCTION_LINES_DEFAULT = 200
CHILD_FUNCTION_LINES_DEFAULT = 60
NESTED_ASSEMBLY_DEFAULT = 4
TEST_PATH_PREFIX = "test/"
ESLINT_CONFIG_FILE = "eslint.config.mjs"
COMPLEXITY_CONSTANT = "COMPLEXITY_THRESHOLD"
COGNITIVE_CONSTANT = "COGNITIVE_COMPLEXITY_THRESHOLD"
FALLBACK_THRESHOLDS = {COMPLEXITY_RULE: 10, COGNITIVE_RULE: 10}
SCORE_PATTERN = re.compile(r"complexity of (\d+)", re.IGNORECASE)
COGNITIVE_SCORE_PATTERN = re.compile(
    r"cognitive complexity from (\d+)", re.IGNORECASE
)
FUNCTION_PATTERN = re.compile(
    r"(?:async\s+)?(?:function|method)\s+['\"]?([^'\"]+)['\"]?\s+has",
    re.IGNORECASE,
)
SOURCE_FUNCTION_PATTERN = re.compile(
    r"\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(", re.IGNORECASE
)
SOURCE_METHOD_PATTERN = re.compile(
    r"^\s*(?:(?:public|private|protected|static|abstract|override|get|set|async)\s+)*"
    r"([A-Za-z_$][\w$]*)\s*(?:<[^>]+>)?\s*\(",
    re.IGNORECASE,
)
SOURCE_ARROW_PATTERN = re.compile(
    r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=.*=>", re.IGNORECASE
)
STRUCTURE_LINES_PATTERN = re.compile(r"has too many lines \((\d+)\)", re.IGNORECASE)
# Messages look like: "Async method 'save' has too many lines (213). Maximum allowed is 150."
STRUCTURE_SUBJECT_PATTERN = re.compile(
    r"^(?P<kind>[A-Za-z ]*?)(?:\s*\x27(?P<name>[^\x27]+)\x27|\"(?P<quoted>[^\"]+)\")?\s+has too many lines",
    re.IGNORECASE,
)
SEVERITY_RANK = {"critical": 3, "high": 2, "moderate": 1}


@dataclass(frozen=True)
class Finding:
    """One complexity warning emitted by ESLint."""

    path: str
    name: str
    rule: str
    score: int
    threshold: int
    line: int
    column: int
    message: str

    @property
    def excess(self) -> int:
        return self.score - self.threshold

    @property
    def ratio(self) -> float:
        return self.score / self.threshold

    @property
    def severity(self) -> str:
        if self.ratio >= 4:
            return "critical"
        if self.ratio >= 2:
            return "high"
        return "moderate"


@dataclass
class StructureNode:
    # One function's physical size, as measured by ESLint's AST-based structural rule.

    path: str
    name: str
    kind: str
    line: int
    lines: int
    parent: "StructureNode | None" = None
    children: list["StructureNode"] = field(default_factory=list)

    @property
    def end_line(self) -> int:
        # The rule counts physical lines of the function node, so this span is exact.
        return self.line + self.lines - 1

    @property
    def depth(self) -> int:
        return 1 if self.parent is None else self.parent.depth + 1

    @property
    def self_lines(self) -> int:
        return max(self.lines - sum(child.lines for child in self.children), 0)

    @property
    def nested_functions(self) -> int:
        return sum(1 + child.nested_functions for child in self.children)

    @property
    def label(self) -> str:
        return self.name or f"<{self.kind}>"


@dataclass
class Report:
    """Parsed findings, function-size inventory, and non-complexity lint diagnostics."""

    files_analyzed: int
    findings: list[Finding]
    other_messages: list[dict[str, Any]]
    eslint_exit_code: int | None
    thresholds: dict[str, int]
    structure: list[StructureNode] = field(default_factory=list)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="repository root (default: parent of scripts/)",
    )
    parser.add_argument(
        "--target",
        action="append",
        default=None,
        help="path passed to ESLint; repeat for multiple paths (default: .)",
    )
    parser.add_argument(
        "--input",
        type=Path,
        metavar="ESLINT_JSON",
        help="read an existing ESLint JSON report instead of running ESLint",
    )
    parser.add_argument(
        "--eslint",
        default=None,
        metavar="COMMAND",
        help="ESLint executable or command (default: local node_modules/.bin/eslint)",
    )
    parser.add_argument(
        "--complexity-threshold",
        type=int,
        default=None,
        help=f"override complexity threshold from {ESLINT_CONFIG_FILE}",
    )
    parser.add_argument(
        "--cognitive-threshold",
        type=int,
        default=None,
        help=f"override cognitive threshold from {ESLINT_CONFIG_FILE}",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=10,
        help="number of functions/files/subsystems to show (default: 10)",
    )
    parser.add_argument(
        "--format",
        choices=("text", "json"),
        default="text",
        help="report output format (default: text)",
    )
    parser.add_argument(
        "--min-function-lines",
        type=int,
        default=MIN_FUNCTION_LINES_DEFAULT,
        metavar="N",
        help="inventory every function at least this long (default: 20)",
    )
    parser.add_argument(
        "--big-function-lines",
        type=int,
        default=BIG_FUNCTION_LINES_DEFAULT,
        metavar="N",
        help="length that makes a function a structural outlier (default: 200)",
    )
    parser.add_argument(
        "--no-structure",
        action="store_true",
        help="skip the function-size pass and report only complexity metrics",
    )
    parser.add_argument(
        "--fail-on",
        choices=("none", "findings", "critical"),
        default="none",
        help="return status 1 when findings or critical findings are present",
    )
    args = parser.parse_args(argv)

    if args.top < 1:
        parser.error("--top must be at least 1")
    if args.min_function_lines < 1:
        parser.error("--min-function-lines must be positive")
    if args.big_function_lines < args.min_function_lines:
        parser.error("--big-function-lines must be at least --min-function-lines")
    if args.complexity_threshold is not None and args.complexity_threshold < 1:
        parser.error("complexity threshold must be positive")
    if args.cognitive_threshold is not None and args.cognitive_threshold < 1:
        parser.error("cognitive threshold must be positive")
    return args


def load_thresholds(root: Path) -> dict[str, int]:
    thresholds = FALLBACK_THRESHOLDS.copy()
    path = root / ESLINT_CONFIG_FILE
    try:
        source = path.read_text()
    except OSError:
        return thresholds

    constants = {
        COMPLEXITY_RULE: COMPLEXITY_CONSTANT,
        COGNITIVE_RULE: COGNITIVE_CONSTANT,
    }
    for rule, name in constants.items():
        match = re.search(rf"\bconst\s+{name}\s*=\s*(\d+)\s*;", source)
        if match:
            thresholds[rule] = int(match.group(1))
    return thresholds


def read_json(path: Path | None) -> tuple[Any, int | None]:
    if path is None:
        raise ValueError("an input path is required")

    try:
        content = sys.stdin.read() if str(path) == "-" else path.read_text()
        return json.loads(content), None
    except OSError as error:
        raise RuntimeError(f"could not read ESLint report {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise RuntimeError(f"invalid ESLint JSON in {path}: {error}") from error


def eslint_command(root: Path, configured: str | None) -> list[str]:
    if configured:
        return shlex.split(configured)

    candidates = [root / "node_modules/.bin/eslint"]
    if os.name == "nt":
        candidates.insert(0, root / "node_modules/.bin/eslint.cmd")
    for candidate in candidates:
        if candidate.exists():
            return [str(candidate)]

    # This remains offline because --no-install prevents npx from downloading
    # a package unexpectedly. It also gives a useful npm error if ESLint is absent.
    return ["npx", "--no-install", "eslint"]


def structure_rule_json(min_lines: int) -> str:
    """Ask for function sizes in the same pass; --rule adds to the project config."""

    return json.dumps({STRUCTURE_RULE: ["warn", min_lines]})


def run_eslint(
    root: Path, command: list[str], targets: list[str], min_function_lines: int | None
) -> tuple[Any, int]:
    invocation = [
        *command,
        *(targets or ["."]),
        "--format",
        "json",
        "--no-error-on-unmatched-pattern",
    ]
    if min_function_lines:
        invocation += ["--rule", structure_rule_json(min_function_lines)]
    environment = {**os.environ, "FORCE_COLOR": "0", "NO_COLOR": "1"}

    try:
        completed = subprocess.run(
            invocation,
            cwd=root,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as error:
        raise RuntimeError(f"could not run ESLint ({' '.join(invocation)}): {error}") from error

    try:
        data = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        details = completed.stderr.strip() or completed.stdout.strip()
        message = f"ESLint did not produce JSON (exit {completed.returncode})"
        if details:
            message += f":\n{details}"
        raise RuntimeError(message) from error

    return data, completed.returncode


def relative_path(file_path: Any, root: Path) -> str:
    path = Path(str(file_path))
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


@lru_cache(maxsize=256)
def source_lines(path: str, root: str) -> tuple[str, ...]:
    candidate = Path(path)
    if not candidate.is_absolute():
        candidate = Path(root) / candidate
    try:
        return tuple(candidate.read_text().splitlines())
    except (OSError, UnicodeDecodeError):
        return ()


def source_function_name(path: str, line: int, root: Path) -> str | None:
    """Recover a function name when SonarJS omits it from its message."""
    lines = source_lines(path, str(root))
    if not lines or line < 1:
        return None

    # Function declarations and methods normally point directly at their name.
    # Look back a few lines for declarations split across a formatted signature.
    start = min(line - 1, len(lines) - 1)
    for index in range(start, max(-1, start - 8), -1):
        text = lines[index]
        match = SOURCE_FUNCTION_PATTERN.search(text)
        if match:
            return match.group(1)
        match = SOURCE_METHOD_PATTERN.search(text)
        if match:
            name = match.group(1)
            if name not in {"if", "for", "while", "switch", "catch"}:
                return name

    # Named arrow functions are another common form. Keep this fallback narrow
    # so an unrelated assignment above a callback is not mislabeled.
    for index in range(start, max(-1, start - 4), -1):
        match = SOURCE_ARROW_PATTERN.search(lines[index])
        if match:
            return match.group(1)
    return None


def finding_name(message: str, path: str, line: int, root: Path) -> str:
    match = FUNCTION_PATTERN.search(message)
    if match:
        return match.group(1).strip()

    from_source = source_function_name(path, line, root)
    if from_source:
        return from_source

    # SonarJS does not include the name for anonymous callbacks and arrows.
    if message.lower().startswith("refactor this function"):
        return "<anonymous function>"
    prefix = message.split(" has ", 1)[0].strip()
    return prefix or "<unknown>"


def finding_score(rule: str, message: str) -> int | None:
    pattern = COGNITIVE_SCORE_PATTERN if rule == COGNITIVE_RULE else SCORE_PATTERN
    match = pattern.search(message)
    return int(match.group(1)) if match else None


def structure_node(message: str, path: str, line: int) -> StructureNode | None:
    """Build a node from a `max-lines-per-function` message, or None when it is not one."""

    lines_match = STRUCTURE_LINES_PATTERN.search(message)
    if not lines_match:
        return None
    subject_match = STRUCTURE_SUBJECT_PATTERN.match(message)
    kind = (subject_match.group("kind") if subject_match else "").strip().lower()
    name = ""
    if subject_match:
        name = subject_match.group("name") or subject_match.group("quoted") or ""
    return StructureNode(
        path=path,
        name=name,
        kind=kind or "function",
        line=line,
        lines=int(lines_match.group(1)),
    )


def parse_report(
    data: Any,
    root: Path,
    thresholds: dict[str, int],
    exit_code: int | None,
) -> Report:
    if not isinstance(data, list):
        raise RuntimeError("ESLint JSON must contain an array of file result objects")

    findings: list[Finding] = []
    other_messages: list[dict[str, Any]] = []
    structure: list[StructureNode] = []
    for result in data:
        if not isinstance(result, dict):
            continue
        path = relative_path(result.get("filePath", "<unknown>"), root)
        messages = result.get("messages", [])
        if not isinstance(messages, list):
            continue
        for message in messages:
            if not isinstance(message, dict):
                continue
            rule = message.get("ruleId")
            text = str(message.get("message", ""))
            line = int(message.get("line") or 0)
            if rule == STRUCTURE_RULE:
                # Sizes belong to the structure inventory, not the residual lint tally.
                node = structure_node(text, path, line)
                if node:
                    structure.append(node)
                continue
            score = finding_score(rule, text) if rule in RULES else None
            if rule in RULES and score is not None:
                findings.append(
                    Finding(
                        path=path,
                        name=finding_name(
                            text,
                            path,
                            int(message.get("line") or 0),
                            root,
                        ),
                        rule=rule,
                        score=score,
                        threshold=thresholds[rule],
                        line=int(message.get("line") or 0),
                        column=int(message.get("column") or 0),
                        message=text,
                    )
                )
            else:
                other_messages.append(
                    {
                        "path": path,
                        "rule": rule or "(unknown)",
                        "severity": message.get("severity", 0),
                        "message": text,
                        "line": message.get("line", 0),
                    }
                )

    return Report(len(data), findings, other_messages, exit_code, thresholds, structure)



def structure_pattern(node: StructureNode) -> str:
    """Name the readability risk a large span carries, when the metrics show nothing.

    A big body with little nesting accumulates statements in one place; a big span made of many
    functions assembles behavior across closures, so each piece scores alone and nothing does.
    """

    if node.self_lines >= node.lines - node.self_lines:
        return "accumulates"
    return "assembles" if node.nested_functions >= NESTED_ASSEMBLY_DEFAULT else "spans"


def build_structure_tree(nodes: Sequence[StructureNode]) -> list[StructureNode]:
    """Nest function spans inside their enclosing functions using ESLint's line ranges.

    The nodes are mutated with parent and child links, so build the tree once per report.
    """

    roots: list[StructureNode] = []
    by_file: dict[str, list[StructureNode]] = defaultdict(list)
    for node in nodes:
        # Rebuilding must not accumulate child links from an earlier pass.
        node.parent = None
        node.children = []
        by_file[node.path].append(node)

    for file_nodes in by_file.values():
        stack: list[StructureNode] = []
        for node in sorted(file_nodes, key=lambda item: (item.line, -item.lines)):
            while stack and stack[-1].end_line < node.end_line:
                stack.pop()
            if stack:
                node.parent = stack[-1]
                stack[-1].children.append(node)
            else:
                roots.append(node)
            stack.append(node)
    return roots


def structure_rows(
    roots: Sequence[StructureNode], findings: Sequence[Finding]
) -> list[dict[str, Any]]:
    """Flatten the size tree, counting the metric findings each function encloses."""

    finding_lines: dict[str, list[int]] = defaultdict(list)
    for item in findings:
        finding_lines[item.path].append(item.line)

    rows: list[dict[str, Any]] = []

    def walk(node: StructureNode) -> None:
        contained = sum(1 for line in finding_lines[node.path] if node.line <= line <= node.end_line)
        rows.append(
            {
                "path": node.path,
                "name": node.label,
                "kind": node.kind,
                "line": node.line,
                "lines": node.lines,
                "self_lines": node.self_lines,
                "nested_functions": node.nested_functions,
                "depth": node.depth,
                "findings_inside": contained,
                "pattern": structure_pattern(node),
            }
        )
        for child in node.children:
            walk(child)

    for root in roots:
        walk(root)
    return rows


def structure_analysis(
    report: Report, big_lines: int
) -> tuple[list[StructureNode], list[dict[str, Any]], list[dict[str, Any]]]:
    """Return the size tree, its flattened rows, and the large rows with no metric signal."""

    roots = build_structure_tree(report.structure)
    rows = structure_rows(roots, report.findings)
    silent = [
        row
        for row in rows
        if row["findings_inside"] == 0
        and (row["self_lines"] >= big_lines or row["lines"] >= big_lines)
        # Test files assemble from describe/it callbacks by design, so an assembled span there is the
        # framework's shape rather than a readability risk; an undecomposed body still counts.
        and not (row["path"].startswith(TEST_PATH_PREFIX) and row["pattern"] == "assembles")
    ]
    return roots, rows, sorted(silent, key=lambda item: (-item["self_lines"], -item["lines"]))


def render_structure_section(
    roots: Sequence[StructureNode],
    rows: Sequence[dict[str, Any]],
    silent: Sequence[dict[str, Any]],
    top: int,
    big_lines: int,
    child_lines: int,
) -> list[str]:
    """Render the largest functions as a tree so delegation reads as delegation."""

    title = "Function size and nesting (structure)"
    lines = ["", title, "-" * len(title)]
    if not rows:
        lines.append("No size inventory (run without --no-structure to collect it).")
        return lines

    lines.append(
        f"{len(rows)} functions inventoried; ranked by self lines, because that is what a reader holds "
        f"at once. {len(silent)} functions of {big_lines}+ lines carry no complexity finding anywhere "
        f"inside them."
    )
    lines.append(
        "Counts are ESLint physical lines per function node, so an indented row sits inside the row "
        "above it. 'nested' counts functions declared inside, so a huge span with a small self and many "
        "nested pieces is assembled from callbacks; a huge self is one undecomposed body. Size is a "
        "review signal, not a defect threshold."
    )
    lines.append(f"{'self':>6} {'lines':>6} {'nested':>6} {'inside':>6}  function")

    index = {(row["path"], row["line"]): row for row in rows}

    def render_node(node: StructureNode, depth: int) -> None:
        row = index[(node.path, node.line)]
        marker = "  <- no complexity signal" if row in silent else ""
        indent = "  " * (depth - 1) + ("|- " if depth > 1 else "")
        lines.append(
            f"{row['self_lines']:>6} {row['lines']:>6} {row['nested_functions']:>6} "
            f"{row['findings_inside']:>6}  {indent}{row['name']}  "
            f"{row['path']}:{row['line']} [{row['pattern']}]{marker}"
        )
        children = sorted(
            (child for child in node.children if child.lines >= child_lines),
            key=lambda item: (-item.self_lines, -item.lines),
        )
        for child in children:
            render_node(child, depth + 1)
        hidden = len(node.children) - len(children)
        if hidden > 0:
            continuation = "  " * (depth - 1) + ("|- " if depth > 1 else "")
            lines.append(f"{'':>26}  {continuation}+ {hidden} below {child_lines} lines")

    for root in sorted(roots, key=lambda item: (-item.self_lines, -item.lines))[:top]:
        render_node(root, 1)
    return lines



def subsystem(path: str) -> str:
    parts = Path(path).parts
    if not parts:
        return "(unknown)"
    if parts[0] == "src":
        return "/".join(parts[1:3]) or "src"
    if parts[0] == "test":
        return "test/" + (parts[1] if len(parts) > 1 else "")
    return parts[0]


def metric_label(rule: str) -> str:
    return "complexity" if rule == COMPLEXITY_RULE else "cognitive"


def sorted_findings(findings: Iterable[Finding]) -> list[Finding]:
    return sorted(
        findings,
        key=lambda item: (
            -SEVERITY_RANK[item.severity],
            -item.ratio,
            -item.score,
            item.path,
            item.line,
        ),
    )


def metric_findings(report: Report, rule: str) -> list[Finding]:
    return sorted_findings(item for item in report.findings if item.rule == rule)


def file_stats(report: Report) -> list[dict[str, Any]]:
    stats: dict[str, dict[str, Any]] = defaultdict(
        lambda: {
            "path": "",
            "findings": 0,
            "complexity": [],
            "cognitive": [],
        }
    )
    for finding in report.findings:
        item = stats[finding.path]
        item["path"] = finding.path
        item["findings"] += 1
        item[metric_label(finding.rule)].append(finding.score)

    rows = []
    for item in stats.values():
        complexity = item["complexity"]
        cognitive = item["cognitive"]
        normalized = sum(
            finding.ratio
            for finding in report.findings
            if finding.path == item["path"]
        )
        rows.append(
            {
                **item,
                "complexity_total": sum(complexity),
                "complexity_max": max(complexity, default=0),
                "cognitive_total": sum(cognitive),
                "cognitive_max": max(cognitive, default=0),
                "normalized": normalized,
            }
        )
    return sorted(rows, key=lambda row: (-row["normalized"], row["path"]))


def group_stats(report: Report) -> list[dict[str, Any]]:
    groups: dict[str, list[Finding]] = defaultdict(list)
    for finding in report.findings:
        groups[subsystem(finding.path)].append(finding)

    rows = []
    for name, findings in groups.items():
        complexity = [item.score for item in findings if item.rule == COMPLEXITY_RULE]
        cognitive = [item.score for item in findings if item.rule == COGNITIVE_RULE]
        rows.append(
            {
                "subsystem": name,
                "findings": len(findings),
                "files": len({item.path for item in findings}),
                "complexity_count": len(complexity),
                "complexity_max": max(complexity, default=0),
                "complexity_total": sum(complexity),
                "cognitive_count": len(cognitive),
                "cognitive_max": max(cognitive, default=0),
                "cognitive_total": sum(cognitive),
                "normalized": sum(item.ratio for item in findings),
            }
        )
    return sorted(rows, key=lambda row: (-row["normalized"], row["subsystem"]))


def summary(report: Report) -> dict[str, Any]:
    metrics = {}
    for rule in RULES:
        findings = [item for item in report.findings if item.rule == rule]
        metrics[metric_label(rule)] = {
            "violations": len(findings),
            "files": len({item.path for item in findings}),
            "total_score": sum(item.score for item in findings),
            "max_score": max((item.score for item in findings), default=0),
            "severity": dict(
                Counter(item.severity for item in findings)
            ),
        }
    return {
        "files_analyzed": report.files_analyzed,
        "complexity": metrics["complexity"],
        "cognitive": metrics["cognitive"],
        "complexity_findings": len(report.findings),
        "other_lint_messages": len(report.other_messages),
        "structure_functions": len(report.structure),
        "structure_inventory": sorted(
            (
                row
                for row in structure_rows(build_structure_tree(report.structure), report.findings)
                if row["depth"] == 1
            ),
            key=lambda item: -item["lines"],
        ),
        "eslint_exit_code": report.eslint_exit_code,
        "thresholds": {
            metric_label(rule): report.thresholds[rule]
            for rule in RULES
        },
    }


def render_text(
    report: Report,
    top: int,
    big_lines: int = BIG_FUNCTION_LINES_DEFAULT,
    child_lines: int = CHILD_FUNCTION_LINES_DEFAULT,
) -> str:
    lines = [
        "Cognitive-load overview",
        "========================",
        f"ESLint files analyzed: {report.files_analyzed}",
        f"ESLint exit code: {report.eslint_exit_code if report.eslint_exit_code is not None else 'not run (input JSON)'}",
        f"Complexity findings: {sum(item.rule == COMPLEXITY_RULE for item in report.findings)}",
        f"Cognitive findings: {sum(item.rule == COGNITIVE_RULE for item in report.findings)}",
        f"Other lint messages: {len(report.other_messages)}",
        "",
        "Scores are the values reported by ESLint. Severity is derived from the configured thresholds:",
        "moderate (> threshold), high (>= 2x), critical (>= 4x). Priorities are sorted by severity, then normalized score.",
    ]

    for rule in RULES:
        findings = metric_findings(report, rule)
        label = metric_label(rule)
        threshold = report.thresholds[rule]
        if findings:
            threshold = findings[0].threshold
        lines.extend(
            [
                "",
                f"{label.title()} totals (threshold {threshold})",
                "-" * (len(label) + 28),
            ]
        )
        if not findings:
            lines.append("No findings.")
            continue
        total = sum(item.score for item in findings)
        severity_counts = Counter(item.severity for item in findings)
        lines.append(
            f"{len(findings)} violations in {len({item.path for item in findings})} files; "
            f"score total {total}; maximum {findings[0].score}; "
            f"severity {', '.join(f'{key}={severity_counts[key]}' for key in ('critical', 'high', 'moderate') if severity_counts[key])}."
        )
        lines.append("Top functions:")
        for item in findings[:top]:
            lines.append(
                f"  [{item.severity.upper():8}] {item.score:>3} "
                f"{item.path}:{item.line} {item.name} (excess +{item.excess})"
            )

    roots, rows, silent = structure_analysis(report, big_lines)
    lines.extend(render_structure_section(roots, rows, silent, top, big_lines, child_lines))

    lines.extend(["", "Top files", "---------"])
    for row in file_stats(report)[:top]:
        lines.append(
            f"  {row['normalized']:>6.1f}  {row['path']} "
            f"(complexity total {row['complexity_total'] or '-'} / max {row['complexity_max'] or '-'}; "
            f"cognitive total {row['cognitive_total'] or '-'} / max {row['cognitive_max'] or '-'}; "
            f"{row['findings']} findings)"
        )

    lines.extend(["", "By subsystem", "------------"])
    for row in group_stats(report)[:top]:
        lines.append(
            f"  {row['normalized']:>6.1f}  {row['subsystem']} "
            f"({row['files']} files; complexity {row['complexity_count']} findings / total {row['complexity_total']} / max {row['complexity_max'] or '-'}; "
            f"cognitive {row['cognitive_count']} findings / total {row['cognitive_total']} / max {row['cognitive_max'] or '-'})"
        )

    lines.extend(["", "Prioritized actions", "-------------------"])
    for item in sorted_findings(report.findings)[:top]:
        lines.append(
            f"  {item.severity.upper():8} {metric_label(item.rule):9} {item.score:>3} "
            f"({item.ratio:.1f}x threshold) {item.path}:{item.line} {item.name}"
        )
    if not report.findings:
        lines.append("  None.")
    if silent:
        lines.append("")
        lines.append(
            "  Size with no complexity signal (accumulates = one long body, assembles = many callbacks):"
        )
        for row in silent[:top]:
            lines.append(
                f"  STRUCTURE {row['self_lines']:>4} self / {row['lines']:>4} lines  "
                f"{row['pattern']:11} {row['nested_functions']:>2} nested  "
                f"{row['path']}:{row['line']} {row['name']}"
            )

    if report.other_messages:
        rule_counts = Counter(item["rule"] for item in report.other_messages)
        lines.extend(["", "Other lint diagnostics by rule", "-------------------------------"])
        for rule, count in rule_counts.most_common(top):
            lines.append(f"  {count:>4}  {rule}")

    return "\n".join(lines) + "\n"


def render_json(report: Report, top: int) -> str:
    payload = summary(report)
    payload["top_functions"] = {
        metric_label(rule): [
            asdict(item) | {"severity": item.severity, "excess": item.excess}
            for item in metric_findings(report, rule)[:top]
        ]
        for rule in RULES
    }
    payload["top_files"] = file_stats(report)[:top]
    payload["subsystems"] = group_stats(report)[:top]
    payload["other_rules"] = dict(Counter(item["rule"] for item in report.other_messages))
    return json.dumps(payload, indent=2, sort_keys=True) + "\n"


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    root = args.root.resolve()
    configured_thresholds = load_thresholds(root)
    thresholds = {
        COMPLEXITY_RULE: args.complexity_threshold
        if args.complexity_threshold is not None
        else configured_thresholds[COMPLEXITY_RULE],
        COGNITIVE_RULE: args.cognitive_threshold
        if args.cognitive_threshold is not None
        else configured_thresholds[COGNITIVE_RULE],
    }

    try:
        if args.input:
            data, exit_code = read_json(args.input)
        else:
            data, exit_code = run_eslint(
                root,
                eslint_command(root, args.eslint),
                args.target or ["."],
                None if args.no_structure else args.min_function_lines,
            )
        report = parse_report(data, root, thresholds, exit_code)
    except RuntimeError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    if args.format == "json":
        output = render_json(report, args.top)
    else:
        output = render_text(report, args.top, args.big_function_lines)
    print(output, end="")

    if args.fail_on == "findings" and report.findings:
        return 1
    if args.fail_on == "critical" and any(item.severity == "critical" for item in report.findings):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
