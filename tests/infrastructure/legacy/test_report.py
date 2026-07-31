"""리포트 CLI 테스트."""

from pathlib import Path

import pytest

from sooljang.infrastructure.legacy.report import main

FIXTURE = Path(__file__).parent / "testdata" / "sample_sheet.csv"


def test_summary_reports_block_separation(capsys: pytest.CaptureFixture[str]) -> None:
    exit_code = main([str(FIXTURE), "--samples", "0"])
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "레코드            7건" in output
    assert "통과한 빈 행      1개" in output
    assert "배제한 합계행     1개" in output


def test_summary_reports_aggregates(capsys: pytest.CaptureFixture[str]) -> None:
    main([str(FIXTURE), "--samples", "0"])
    output = capsys.readouterr().out

    assert "14 / 8 / 6병" in output
    assert "545,980원" in output
    assert "9,300ml" in output


def test_summary_flags_items_needing_review(capsys: pytest.CaptureFixture[str]) -> None:
    main([str(FIXTURE), "--samples", "0"])
    output = capsys.readouterr().out

    assert "구매처 여러 곳       1행" in output
    assert "가상신주종" in output


def test_samples_include_normalized_fields(capsys: pytest.CaptureFixture[str]) -> None:
    main([str(FIXTURE), "--samples", "3"])
    output = capsys.readouterr().out

    assert "정규화 샘플" in output
    # 빈티지 분리, 주종 경로, 품종 오타 정규화가 보여야 한다.
    assert "가상 와이너리 카베르네" in output
    assert "와인 > 레드와인" in output
    assert "Cabernet Sauvignon" in output


def test_samples_show_foreign_currency(capsys: pytest.CaptureFixture[str]) -> None:
    main([str(FIXTURE), "--samples", "3"])
    output = capsys.readouterr().out

    assert "USD 69.79" in output


def test_warnings_flag_prints_all_warnings(capsys: pytest.CaptureFixture[str]) -> None:
    main([str(FIXTURE), "--samples", "0", "--warnings"])
    output = capsys.readouterr().out

    assert "경고 전체" in output
    assert "사전에 없는 값입니다" in output


def test_missing_file_returns_error_code(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    exit_code = main([str(tmp_path / "없는파일.csv")])

    assert exit_code == 1
    assert "읽을 수 없습니다" in capsys.readouterr().err


def test_unrecognized_sheet_returns_error_code(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    bad = tmp_path / "다른시트.csv"
    bad.write_bytes("컬럼1,컬럼2\n1,2\n".encode("cp949"))

    exit_code = main([str(bad)])

    assert exit_code == 1
    assert "해석할 수 없습니다" in capsys.readouterr().err
