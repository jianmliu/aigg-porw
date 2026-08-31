"""Fail closed unless a pytest JUnit report proves the mandatory Triton gate."""

from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Never

REQUIRED_KERNEL_TESTS = frozenset(
    {
        "test_sweep_kernel_matches_reference",
        "test_sweep_kernel_coverage_subset",
        "test_sweep_wrapper_rejects_invalid_tile_ids_before_launch",
        "test_sweep_internal_full_coverage_skips_caller_validation",
        "test_sweep_empty_external_coverage_returns_uint32_without_launch",
        "test_moe_kernel_gemm_correct",
        "test_moe_kernel_sketch_matches_spec",
        "test_moe_kernel_batch_invariance",
        "test_fused_equals_sweep_on_covered_tiles",
        "test_prepared_moe_launch_matches_reference_and_reuses_outputs",
        "test_prepared_sweep_launch_matches_reference_and_reuses_output",
    }
)


def _fail(message: str) -> Never:
    raise SystemExit(f"interpreter gate failed: {message}")


def _nonnegative_count(suite: ET.Element, attribute: str) -> int:
    raw = suite.attrib.get(attribute)
    if raw is None:
        _fail(f"testsuite omits {attribute!r}")
    try:
        value = int(raw)
    except ValueError:
        _fail(f"testsuite has invalid {attribute!r}: {raw!r}")
    if value < 0:
        _fail(f"testsuite has negative {attribute!r}: {value}")
    return value


def check_report(report_path: Path) -> int:
    """Validate one regular JUnit report and return its accepted test count."""
    if report_path.is_symlink() or not report_path.is_file():
        _fail(f"report must be a regular file: {report_path}")
    try:
        root = ET.parse(report_path).getroot()
    except (ET.ParseError, OSError) as error:
        _fail(f"cannot parse report: {error}")

    suites: tuple[ET.Element, ...]
    if root.tag == "testsuite":
        suites = (root,)
    elif root.tag == "testsuites":
        suites = tuple(root.findall("testsuite"))
    else:
        _fail(f"unexpected JUnit root: {root.tag!r}")
    if not suites:
        _fail("report contains no testsuites")

    declared_tests = sum(_nonnegative_count(suite, "tests") for suite in suites)
    declared_skipped = sum(_nonnegative_count(suite, "skipped") for suite in suites)
    declared_failures = sum(_nonnegative_count(suite, "failures") for suite in suites)
    declared_errors = sum(_nonnegative_count(suite, "errors") for suite in suites)
    cases = [case for suite in suites for case in suite.findall("testcase")]
    case_skips = sum(case.find("skipped") is not None for case in cases)
    case_failures = sum(case.find("failure") is not None for case in cases)
    case_errors = sum(case.find("error") is not None for case in cases)
    names = {case.attrib.get("name", "") for case in cases}
    missing = sorted(REQUIRED_KERNEL_TESTS - names)

    if declared_tests != len(cases):
        _fail(f"declared tests={declared_tests}, testcase elements={len(cases)}")
    if (
        declared_tests == 0
        or declared_skipped
        or case_skips
        or declared_failures
        or case_failures
        or declared_errors
        or case_errors
        or missing
    ):
        _fail(
            f"tests={declared_tests}, skipped={declared_skipped}, "
            f"case_skips={case_skips}, failures={declared_failures}, "
            f"case_failures={case_failures}, errors={declared_errors}, "
            f"case_errors={case_errors}, missing_kernel_tests={missing}"
        )
    return declared_tests


def main() -> None:
    if len(sys.argv) != 2:
        _fail("usage: check_triton_interpreter_report.py JUNIT_XML")
    report = Path(sys.argv[1]).absolute()
    accepted = check_report(report)
    print(f"interpreter gate accepted {accepted} tests with zero skips")


if __name__ == "__main__":
    main()
