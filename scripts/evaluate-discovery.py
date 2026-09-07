#!/usr/bin/env python3
"""네트워크 없이 합성 매칭셋의 품질·실행 시간·메모리를 측정한다."""

import argparse
import json
import statistics
import time
import tracemalloc
from dataclasses import asdict
from pathlib import Path

from sooljang.infrastructure.external.evaluation import evaluate_matching


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="B04 수용 기준을 함께 판정")
    args = parser.parse_args()
    fixture = Path(__file__).resolve().parents[1] / "tests/fixtures/discovery_cases.json"
    payload = json.loads(fixture.read_text())
    cases = payload["cases"]
    timings = []
    for _ in range(7):
        start = time.perf_counter()
        result = evaluate_matching(cases)
        timings.append((time.perf_counter() - start) * 1000)
    tracemalloc.start()
    evaluate_matching(cases)
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    result = evaluate_matching(cases)
    passed = (
        result.false_auto_accepted == 0
        and result.precision == 1
        and (result.candidate_recall or 0) >= 0.8
        and (result.automatic_coverage or 0) >= 0.5
    )
    print(
        json.dumps(
            {
                "fixture_version": payload["version"],
                **asdict(result),
                "auto_precision": result.precision,
                "candidate_recall": result.candidate_recall,
                "automatic_coverage": result.automatic_coverage,
                "median_ms": round(statistics.median(timings), 3),
                "peak_bytes": peak,
                "network_requests": 0,
                "acceptance_passed": passed,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return int(args.check and not passed)


if __name__ == "__main__":
    raise SystemExit(main())
