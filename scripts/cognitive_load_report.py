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
    eslint . --format json > eslint.json
    python3 scripts/cognitive_load_report.py --input eslint.json
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
from dataclasses import asdict, dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable, Sequence

COMPLEXITY_RULE = "complexity"
COGNITIVE_RULE = "sonarjs/cognitive-complexity"
RULES = (COMPLEXITY_RULE, COGNITIVE_RULE)
DEFAULT_THRESHOLDS = {COMPLEXITY_RULE: 10, COGNITIVE_RULE: 15}
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
class Report:
    """Parsed findings and non-complexity lint diagnostics."""

    files_analyzed: int
    findings: list[Finding]
    other_messages: list[dict[str, Any]]
    eslint_exit_code: int | None


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
        default=DEFAULT_THRESHOLDS[COMPLEXITY_RULE],
        help="threshold used for complexity severity (default: 10)",
    )
    parser.add_argument(
        "--cognitive-threshold",
        type=int,
        default=DEFAULT_THRESHOLDS[COGNITIVE_RULE],
        help="threshold used for cognitive severity (default: 15)",
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
        "--fail-on",
        choices=("none", "findings", "critical"),
        default="none",
        help="return status 1 when findings or critical findings are present",
    )
    args = parser.parse_args(argv)

    if args.top < 1:
        parser.error("--top must be at least 1")
    if args.complexity_threshold < 1 or args.cognitive_threshold < 1:
        parser.error("complexity thresholds must be positive")
    return args


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


def run_eslint(root: Path, command: list[str], targets: list[str]) -> tuple[Any, int]:
    invocation = [
        *command,
        *(targets or ["."]),
        "--format",
        "json",
        "--no-error-on-unmatched-pattern",
    ]
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

    return Report(len(data), findings, other_messages, exit_code)


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
        "eslint_exit_code": report.eslint_exit_code,
    }


def render_text(report: Report, top: int) -> str:
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
        threshold = DEFAULT_THRESHOLDS[rule]
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
    thresholds = {
        COMPLEXITY_RULE: args.complexity_threshold,
        COGNITIVE_RULE: args.cognitive_threshold,
    }

    try:
        if args.input:
            data, exit_code = read_json(args.input)
        else:
            data, exit_code = run_eslint(root, eslint_command(root, args.eslint), args.target or ["."])
        report = parse_report(data, root, thresholds, exit_code)
    except RuntimeError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    output = render_json(report, args.top) if args.format == "json" else render_text(report, args.top)
    print(output, end="")

    if args.fail_on == "findings" and report.findings:
        return 1
    if args.fail_on == "critical" and any(item.severity == "critical" for item in report.findings):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
