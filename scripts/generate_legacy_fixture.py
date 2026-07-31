#!/usr/bin/env python3
"""테스트용 익명화 레거시 시트 픽스처를 생성한다.

실제 개인 기록은 저장소에 커밋하지 않는다(`docs/plan.md` §8). 대신 실제 시트의 **구조적
함정**을 그대로 재현한 합성 데이터를 만든다. 재현 대상은 다음과 같다.

- CP949 인코딩, 원화 기호가 백슬래시(0x5C)로 저장됨
- 데이터 구간 중간의 빈 행 (종료가 아님)
- 본 테이블 합계행 (이름이 비어 있고 병수만 채워짐)
- 통계 블록: 주종별 통계 + 좌우로 나란히 놓인 랭킹·롤업 매트릭스
- `종류` 컬럼이 그룹 구분자로만 채워진 형태
- 셀 내 개행 다중값 (품종·외부 평점·구매처·이름 부가설명·느낀 점)
- `#N/A` 수식 오류, 무가격 `\\-`, 이름 후행 빈티지, 비고 내 외화

    python3 scripts/generate_legacy_fixture.py
"""

import csv
import io
from pathlib import Path

OUTPUT = Path(__file__).resolve().parents[1] / (
    "tests/infrastructure/legacy/testdata/sample_sheet.csv"
)

HEADER = [
    "이름",
    "용량",
    "도수",
    "종류",
    "품종",
    "가격",
    "실구매가",
    "평단가",
    "실평단가",
    "100ml당 가격",
    "구매",
    "소비",
    "재고",
    "미개봉",
    "개봉",
    "구매처",
    "비고",
    "내 평점",
    "외부 평점",
    "느낀 점",
]

W = "\\"  # CP949 에서 원화 기호로 표시되는 백슬래시


def money(value: str) -> str:
    return f" {W}{value} "


BLANK = [""] * 20
NO_PRICE = money("-")


def data_row(
    name,
    volume,
    abv,
    category,
    variety,
    list_total,
    paid_total,
    unit_list,
    unit_paid,
    per100,
    counts,
    vendor,
    note,
    mine,
    external,
    tasting,
):
    purchased, consumed, in_stock, unopened, opened = counts
    return [
        name,
        volume,
        abv,
        category,
        variety,
        list_total,
        paid_total,
        unit_list,
        unit_paid,
        per100,
        str(purchased),
        str(consumed),
        str(in_stock),
        str(unopened),
        str(opened),
        vendor,
        note,
        mine,
        external,
        tasting,
    ]


rows: list[list[str]] = [HEADER]

# --- 본 데이터 구간 1: 종류가 첫 행에만 있다 (그룹 구분자) --------------------
rows.append(
    data_row(
        "가상 와이너리 카베르네, 2019",
        "750ml",
        "14.5%",
        "레드와인",
        "Carbernet Sauvignon",
        money("23,980"),
        money("23,980"),
        money("23,980"),
        money("23,980"),
        money("3,197"),
        (1, 1, 0, 0, 0),
        "가상마트 1호점",
        "",
        "4.0",
        "3.9",
        "음식과 먹기에는 괜찮으나\n잔당감이 별로 없음",
    )
)
rows.append(
    data_row(
        "가상 와이너리 메를로",
        "750ml",
        "13.5%",
        "",
        "Merlot",
        money("60,000"),
        money("48,000"),
        money("30,000"),
        money("24,000"),
        money("4,000"),
        (2, 0, 2, 2, 0),
        "가상마트 1호점\n가상온라인샵",
        "1+1 행사",
        "",
        "3.7",
        "",
    )
)
rows.append(
    data_row(
        "가상 샤토 소테른, 2015",
        "375ml",
        "13.0%",
        "소테른/바르삭/루피악 와인",
        "Semillon",
        money("120,000"),
        money("90,000"),
        money("60,000"),
        money("45,000"),
        money("16,000"),
        (2, 1, 1, 0, 1),
        "가상면세점",
        "$69.79 (환율 1431.9원)",
        "5.5",
        "3.88 (RB)\n4.28/95 (BA)\n3.834 (U)",
        "귀부 특유의 꿀향",
    )
)

# --- 함정 1: 데이터 구간 중간의 빈 행. 종료가 아니다 -------------------------
rows.append(list(BLANK))

# --- 본 데이터 구간 2 -------------------------------------------------------
rows.append(
    data_row(
        "가상 백주 38도",
        "500ml",
        "38.0%",
        "백주",
        "농향형",
        money("32,000"),
        money("32,000"),
        money("16,000"),
        money("16,000"),
        money("3,200"),
        (2, 2, 0, 0, 0),
        "가상선물하기",
        "1+1",
        "3.5",
        "",
        "",
    )
)
rows.append(
    data_row(
        "가상 탁주\n25/04/10 발효",
        "900ml",
        "6.5%",
        "전통주(탁주)",
        "",
        NO_PRICE,
        NO_PRICE,
        NO_PRICE,
        NO_PRICE,
        NO_PRICE,
        (3, 3, 0, 0, 0),
        "가상양조장",
        "",
        "4.5",
        "3.482 (U)",
        "산미가 좋다",
    )
)
rows.append(
    data_row(
        "가상 증류소 싱글몰트 12y",
        "700ml",
        "46.0%",
        "싱글몰트 위스키",
        "",
        money("300,000"),
        money("240,000"),
        money("100,000"),
        money("80,000"),
        money("14,286"),
        (3, 1, 2, 1, 1),
        "가상보틀샵",
        "회원 할인",
        "5.0",
        "4.1",
        "바닐라와 꿀",
    )
)
# 사전에 없는 종류 → 미분류로 보존되어야 한다
rows.append(
    data_row(
        "가상 신종 주류",
        "500ml",
        "20.0%",
        "가상신주종",
        "",
        money("10,000"),
        money("10,000"),
        money("10,000"),
        money("10,000"),
        money("2,000"),
        (1, 0, 1, 1, 0),
        "가상마트 2호점",
        "",
        "",
        "",
        "",
    )
)

# --- 함정 2: 본 테이블 합계행. 이름이 비어 있고 병수만 채워져 있다 -----------
total = list(BLANK)
# 750*1 + 750*2 + 375*2 + 500*2 + 900*3 + 700*3 + 500*1 = 9,300ml
total[1] = "9300ml"
total[5] = money("545,980")
total[6] = money("443,980")
total[7] = money("39,333")
total[8] = money("33,855")
total[9] = money("6,015")
total[10:15] = ["14", "8", "6", "4", "2"]
total[17] = "4.5"
rows.append(total)

rows.append(list(BLANK))

# --- 통계 블록 1: 주종별 통계 (스키마가 다르다) ------------------------------
stats_header = list(BLANK)
stats_header[1:19] = [
    "랭킹",
    "평점",
    "품목",
    "할인율",
    "총 가격",
    "총 실구매가",
    "평균 가격",
    "평균 실구매가",
    "100ml가",
    "구매",
    "소비",
    "재고",
    "미개봉",
    "개봉",
    "총 가격 순위",
    "총 실구매가 순위",
    "평균가 순위",
    "평균 실구매가 순위",
]
rows.append(stats_header)

for rank, name, counts in (("1", "레드와인", (3, 1, 2, 2, 0)), ("#N/A", "백주", (2, 2, 0, 0, 0))):
    stat = list(BLANK)
    stat[1] = rank
    stat[2] = "4.90"
    stat[3] = name
    stat[4] = "11%"
    stat[5] = money("83,980")
    stat[6] = money("71,980")
    stat[10:15] = [str(value) for value in counts]
    rows.append(stat)

stats_total = list(BLANK)
stats_total[4] = "14%"
stats_total[5] = money("545,980")
stats_total[6] = money("443,980")
stats_total[10:15] = ["14", "8", "6", "4", "2"]
rows.append(stats_total)

rows.append(list(BLANK))

# --- 함정 3: 좌우로 나란히 놓인 두 블록 --------------------------------------
#     좌: 병당 가격 랭킹 / 우(컬럼 9~14): 주종 롤업 병수 매트릭스
#     이 행들은 이름이 비어 있지 않고 병수 컬럼이 정수라 모양만으로는 데이터로 보인다.
#     도수 칸에 라벨·금액이 들어 있어 도수로 해석되지 않는 점으로 배제한다.
side_header = list(BLANK)
side_header[10:15] = ["구", "소", "재", "미", "개"]
rows.append(side_header)

side_rows = [
    ("병당 가격 상위 3위 술", "병당 가격", "레드와인", (3, 1, 2, 2, 0)),
    ("가상 증류소 싱글몰트 12y", money("100,000"), "백주", (2, 2, 0, 0, 0)),
    ("가상 샤토 소테른", money("60,000"), "와인", (5, 2, 3, 2, 1)),
    ("가상 와이너리 메를로", money("30,000"), "양주", (3, 1, 2, 1, 1)),
]
for left_name, left_value, rollup_name, counts in side_rows:
    row = list(BLANK)
    row[0] = left_name
    row[2] = left_value
    row[9] = rollup_name
    row[10:15] = [str(value) for value in counts]
    rows.append(row)

subtotal = list(BLANK)
subtotal[2] = money("190,000")
rows.append(subtotal)

buffer = io.StringIO(newline="")
csv.writer(buffer, lineterminator="\r\n").writerows(rows)
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_bytes(buffer.getvalue().encode("cp949"))

print(f"{OUTPUT} 생성 완료")
print(f"  논리 행 {len(rows)}개, 본 데이터 7행, 합계행 1행")
