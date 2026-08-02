"""병 상태 전이와 시음 세션 테스트.

잔량 계산이 조용히 틀리면 재고와 통계가 함께 어긋난다. 경계값을 촘촘히 본다.
"""

import datetime
import uuid
from decimal import Decimal

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.application.tastings import (
    BottleTransitionError,
    InsufficientRemainingError,
    InvalidRatingError,
    TastingInput,
    finish_bottle,
    hand_over_bottle,
    list_tastings,
    open_bottle,
    record_tasting,
    reopen_bottle,
    summarize_tastings,
    unopen_bottle,
    validate_rating,
)
from sooljang.infrastructure.database.models import (
    Bottle,
    BottleStatus,
    Category,
    Product,
    Purchase,
    Sku,
)

USER_ID = uuid.UUID("00000000-0000-0000-0000-0000000000aa")
TODAY = datetime.date(2026, 7, 1)


@pytest_asyncio.fixture
async def bottle(session: AsyncSession) -> Bottle:
    """750ml 미개봉 병 하나."""
    category = Category(user_id=USER_ID, name="위스키", slug="whisky", sort_order=1)
    session.add(category)
    await session.flush()

    product = Product(
        user_id=USER_ID,
        name="테스트 위스키",
        normalized_name="테스트위스키",
        category_id=category.id,
    )
    session.add(product)
    await session.flush()

    sku = Sku(user_id=USER_ID, product_id=product.id, volume_ml=750)
    session.add(sku)
    await session.flush()

    purchase = Purchase(user_id=USER_ID, sku_id=sku.id, quantity=1)
    session.add(purchase)
    await session.flush()

    record = Bottle(user_id=USER_ID, purchase_id=purchase.id, label_no=1)
    session.add(record)
    await session.flush()
    return record


async def _sku_id_of(session: AsyncSession, bottle: Bottle) -> uuid.UUID:
    purchase = await session.get(Purchase, bottle.purchase_id)
    assert purchase is not None
    return purchase.sku_id


class TestRatingValidation:
    @pytest.mark.parametrize("value", ["0", "0.5", "3.5", "6.0"])
    def test_유효한_평점(self, value: str) -> None:
        assert validate_rating(Decimal(value)) == Decimal(value)

    def test_없는_평점은_통과한다(self) -> None:
        assert validate_rating(None) is None

    @pytest.mark.parametrize("value", ["-0.5", "6.5", "7"])
    def test_범위를_벗어나면_거부한다(self, value: str) -> None:
        with pytest.raises(InvalidRatingError, match="0 이상 6.0 이하"):
            validate_rating(Decimal(value))

    @pytest.mark.parametrize("value", ["3.7", "0.1", "4.25"])
    def test_반점_단위가_아니면_거부한다(self, value: str) -> None:
        # 레거시 시트가 0.5 단위였으므로 통계 대조를 위해 척도를 지킨다.
        with pytest.raises(InvalidRatingError, match="0.5 단위"):
            validate_rating(Decimal(value))


class TestOpenBottle:
    async def test_개봉하면_잔량이_규격_용량으로_초기화된다(
        self, session: AsyncSession, bottle: Bottle
    ) -> None:
        await open_bottle(session, bottle, opened_on=TODAY)

        assert bottle.status == BottleStatus.OPEN
        assert bottle.opened_on == TODAY
        assert bottle.remaining_ml == 750

    async def test_잔량을_직접_지정할_수_있다(self, session: AsyncSession, bottle: Bottle) -> None:
        # 이미 마신 상태로 기록을 시작하는 경우가 있다.
        await open_bottle(session, bottle, opened_on=TODAY, remaining_ml=500)
        assert bottle.remaining_ml == 500

    async def test_이미_개봉한_병은_다시_개봉할_수_없다(
        self, session: AsyncSession, bottle: Bottle
    ) -> None:
        await open_bottle(session, bottle, opened_on=TODAY)
        with pytest.raises(BottleTransitionError, match="미개봉 병만"):
            await open_bottle(session, bottle)


class TestFinishBottle:
    async def test_소진하면_잔량이_0이_된다(self, session: AsyncSession, bottle: Bottle) -> None:
        await open_bottle(session, bottle, opened_on=TODAY)
        await finish_bottle(session, bottle, finished_on=TODAY + datetime.timedelta(days=30))

        assert bottle.status == BottleStatus.FINISHED
        assert bottle.remaining_ml == 0
        assert bottle.finished_on == TODAY + datetime.timedelta(days=30)

    async def test_미개봉_병도_바로_소진할_수_있다(
        self, session: AsyncSession, bottle: Bottle
    ) -> None:
        # 개봉일을 적지 않고 마셔 버린 뒤 나중에 정리하는 일이 흔하다.
        await finish_bottle(session, bottle, finished_on=TODAY)

        assert bottle.status == BottleStatus.FINISHED
        assert bottle.opened_on == TODAY, "개봉일을 소진일과 같게 채워야 한다"

    async def test_소진일이_개봉일보다_앞서면_거부한다(
        self, session: AsyncSession, bottle: Bottle
    ) -> None:
        await open_bottle(session, bottle, opened_on=TODAY)
        with pytest.raises(BottleTransitionError, match="앞설 수 없습니다"):
            await finish_bottle(session, bottle, finished_on=TODAY - datetime.timedelta(days=1))

    async def test_내보낸_병은_소진할_수_없다(self, session: AsyncSession, bottle: Bottle) -> None:
        await hand_over_bottle(session, bottle, status=BottleStatus.GIFTED, on=TODAY)
        with pytest.raises(BottleTransitionError, match="이미 내보낸"):
            await finish_bottle(session, bottle)


class TestHandOver:
    async def test_증여하면_잔량을_보존한다(self, session: AsyncSession, bottle: Bottle) -> None:
        # 남은 양이 있는 채로 넘긴 사실을 보존해야 한다.
        await open_bottle(session, bottle, opened_on=TODAY, remaining_ml=400)
        await hand_over_bottle(
            session, bottle, status=BottleStatus.GIFTED, note="친구에게", on=TODAY
        )

        assert bottle.status == BottleStatus.GIFTED
        assert bottle.remaining_ml == 400, "증여는 잔량을 0으로 만들지 않는다"
        assert bottle.note is not None and "친구에게" in bottle.note

    async def test_판매도_같은_경로다(self, session: AsyncSession, bottle: Bottle) -> None:
        await hand_over_bottle(session, bottle, status=BottleStatus.SOLD, on=TODAY)
        assert bottle.status == BottleStatus.SOLD

    async def test_증여_판매_외_상태는_거부한다(
        self, session: AsyncSession, bottle: Bottle
    ) -> None:
        with pytest.raises(BottleTransitionError, match="증여 또는 판매"):
            await hand_over_bottle(session, bottle, status=BottleStatus.FINISHED)

    async def test_소진한_병은_넘길_수_없다(self, session: AsyncSession, bottle: Bottle) -> None:
        await finish_bottle(session, bottle, finished_on=TODAY)
        with pytest.raises(BottleTransitionError, match="이미 소진"):
            await hand_over_bottle(session, bottle, status=BottleStatus.GIFTED)

    async def test_기존_메모를_지우지_않는다(self, session: AsyncSession, bottle: Bottle) -> None:
        bottle.note = "선물받은 병"
        await session.flush()
        await hand_over_bottle(session, bottle, status=BottleStatus.GIFTED, note="다시 선물")

        assert bottle.note is not None
        assert "선물받은 병" in bottle.note
        assert "다시 선물" in bottle.note


class TestReopen:
    async def test_되돌리면_소진일이_지워진다(self, session: AsyncSession, bottle: Bottle) -> None:
        await finish_bottle(session, bottle, finished_on=TODAY)
        await reopen_bottle(session, bottle)

        assert bottle.status == BottleStatus.OPEN
        assert bottle.finished_on is None

    async def test_미개봉_병은_되돌릴_수_없다(self, session: AsyncSession, bottle: Bottle) -> None:
        with pytest.raises(BottleTransitionError, match="되돌릴 상태가 없습니다"):
            await reopen_bottle(session, bottle)


class TestUnopen:
    async def test_개봉을_미개봉으로_되돌린다(self, session: AsyncSession, bottle: Bottle) -> None:
        # 실수로 개봉을 눌렀을 때를 위한 되돌리기다.
        await open_bottle(session, bottle, opened_on=TODAY, remaining_ml=500)
        await unopen_bottle(session, bottle)

        assert bottle.status == BottleStatus.UNOPENED
        assert bottle.opened_on is None
        assert bottle.remaining_ml is None

    async def test_미개봉_병은_되돌릴_수_없다(self, session: AsyncSession, bottle: Bottle) -> None:
        with pytest.raises(BottleTransitionError, match="개봉 상태만"):
            await unopen_bottle(session, bottle)

    async def test_소진한_병은_되돌릴_수_없다(self, session: AsyncSession, bottle: Bottle) -> None:
        # 소진·증여·판매까지 간 병은 reopen 으로 먼저 개봉해야 한다 — 넘기거나 마신 기록을
        # 조용히 지우면 안 된다.
        await finish_bottle(session, bottle, finished_on=TODAY)
        with pytest.raises(BottleTransitionError, match="개봉 상태만"):
            await unopen_bottle(session, bottle)


class TestRecordTasting:
    async def test_시음을_기록하면_잔량이_차감된다(
        self, session: AsyncSession, bottle: Bottle
    ) -> None:
        await open_bottle(session, bottle, opened_on=TODAY)
        sku_id = await _sku_id_of(session, bottle)

        await record_tasting(
            session,
            user_id=USER_ID,
            sku_id=sku_id,
            bottle=bottle,
            data=TastingInput(tasted_on=TODAY, poured_ml=30, rating=Decimal("4.5")),
        )

        assert bottle.remaining_ml == 720

    async def test_미개봉_병에_기록하면_자동으로_개봉된다(
        self, session: AsyncSession, bottle: Bottle
    ) -> None:
        # 마시기 시작한 것 자체가 개봉이다. 따로 버튼을 누르게 하면 잊어버린다.
        sku_id = await _sku_id_of(session, bottle)
        await record_tasting(
            session,
            user_id=USER_ID,
            sku_id=sku_id,
            bottle=bottle,
            data=TastingInput(tasted_on=TODAY, poured_ml=45),
        )

        assert bottle.status == BottleStatus.OPEN
        assert bottle.opened_on == TODAY
        assert bottle.remaining_ml == 705

    async def test_잔량을_초과하면_거부한다(self, session: AsyncSession, bottle: Bottle) -> None:
        # 대개 단위 착각(50ml 을 500 으로)이다. 조용히 음수로 만들면 통계가 틀린다.
        await open_bottle(session, bottle, opened_on=TODAY, remaining_ml=50)
        sku_id = await _sku_id_of(session, bottle)

        with pytest.raises(InsufficientRemainingError) as excinfo:
            await record_tasting(
                session,
                user_id=USER_ID,
                sku_id=sku_id,
                bottle=bottle,
                data=TastingInput(tasted_on=TODAY, poured_ml=500),
            )
        assert excinfo.value.remaining_ml == 50
        assert excinfo.value.requested_ml == 500
        assert bottle.remaining_ml == 50, "거부된 기록이 잔량을 바꿔서는 안 된다"

    async def test_잔량을_정확히_비우면_소진_처리된다(
        self, session: AsyncSession, bottle: Bottle
    ) -> None:
        await open_bottle(session, bottle, opened_on=TODAY, remaining_ml=60)
        sku_id = await _sku_id_of(session, bottle)

        await record_tasting(
            session,
            user_id=USER_ID,
            sku_id=sku_id,
            bottle=bottle,
            data=TastingInput(tasted_on=TODAY, poured_ml=60),
        )

        assert bottle.remaining_ml == 0
        assert bottle.status == BottleStatus.FINISHED, "마지막 잔을 마시면 자동 소진"

    async def test_자동_소진을_끌_수_있다(self, session: AsyncSession, bottle: Bottle) -> None:
        await open_bottle(session, bottle, opened_on=TODAY, remaining_ml=60)
        sku_id = await _sku_id_of(session, bottle)

        await record_tasting(
            session,
            user_id=USER_ID,
            sku_id=sku_id,
            bottle=bottle,
            data=TastingInput(tasted_on=TODAY, poured_ml=60),
            finish_if_empty=False,
        )

        assert bottle.remaining_ml == 0
        assert bottle.status == BottleStatus.OPEN

    async def test_병_없이도_기록할_수_있다(self, session: AsyncSession, bottle: Bottle) -> None:
        # 바에서 잔으로 마신 술은 내 병이 아니지만 평점과 노트는 남기고 싶다.
        sku_id = await _sku_id_of(session, bottle)
        record = await record_tasting(
            session,
            user_id=USER_ID,
            sku_id=sku_id,
            data=TastingInput(tasted_on=TODAY, rating=Decimal("5.0"), place="바"),
        )

        assert record.bottle_id is None
        assert record.place == "바"
        assert bottle.status == BottleStatus.UNOPENED, "내 병은 건드리지 않는다"

    async def test_내보낸_병은_기록할_수_없다(self, session: AsyncSession, bottle: Bottle) -> None:
        sku_id = await _sku_id_of(session, bottle)
        await hand_over_bottle(session, bottle, status=BottleStatus.SOLD, on=TODAY)

        with pytest.raises(BottleTransitionError, match="내보낸 병"):
            await record_tasting(
                session,
                user_id=USER_ID,
                sku_id=sku_id,
                bottle=bottle,
                data=TastingInput(tasted_on=TODAY, poured_ml=30),
            )

    async def test_잘못된_평점은_거부한다(self, session: AsyncSession, bottle: Bottle) -> None:
        sku_id = await _sku_id_of(session, bottle)
        with pytest.raises(InvalidRatingError):
            await record_tasting(
                session,
                user_id=USER_ID,
                sku_id=sku_id,
                data=TastingInput(tasted_on=TODAY, rating=Decimal("3.7")),
            )

    async def test_따른_양이_없으면_잔량이_그대로다(
        self, session: AsyncSession, bottle: Bottle
    ) -> None:
        # 얼마나 마셨는지 기억나지 않는 경우가 있다. 기록 자체는 남겨야 한다.
        await open_bottle(session, bottle, opened_on=TODAY)
        sku_id = await _sku_id_of(session, bottle)

        await record_tasting(
            session,
            user_id=USER_ID,
            sku_id=sku_id,
            bottle=bottle,
            data=TastingInput(tasted_on=TODAY, rating=Decimal("4.0")),
        )
        assert bottle.remaining_ml == 750


class TestSummary:
    async def test_평점_추이를_계산한다(self, session: AsyncSession, bottle: Bottle) -> None:
        await open_bottle(session, bottle, opened_on=TODAY)
        sku_id = await _sku_id_of(session, bottle)

        for offset, rating in ((0, "3.5"), (30, "4.0"), (60, "5.0")):
            await record_tasting(
                session,
                user_id=USER_ID,
                sku_id=sku_id,
                bottle=bottle,
                data=TastingInput(
                    tasted_on=TODAY + datetime.timedelta(days=offset),
                    poured_ml=30,
                    rating=Decimal(rating),
                ),
            )

        summary = await summarize_tastings(session, user_id=USER_ID, sku_id=sku_id)

        assert summary.session_count == 3
        assert summary.rated_count == 3
        assert summary.average_rating == Decimal("4.17")
        assert summary.first_rating == Decimal("3.5")
        assert summary.latest_rating == Decimal("5.0")
        assert summary.rating_change == Decimal("1.5"), "처음보다 1.5점 올랐다"
        assert summary.total_poured_ml == 90
        assert summary.first_tasted_on == TODAY
        assert summary.latest_tasted_on == TODAY + datetime.timedelta(days=60)

    async def test_평점_없는_세션은_평균에서_제외한다(
        self, session: AsyncSession, bottle: Bottle
    ) -> None:
        # 0 으로 세면 평점을 적지 않은 기록이 평균을 끌어내린다.
        sku_id = await _sku_id_of(session, bottle)
        await record_tasting(
            session,
            user_id=USER_ID,
            sku_id=sku_id,
            data=TastingInput(tasted_on=TODAY, rating=Decimal("4.0")),
        )
        await record_tasting(
            session, user_id=USER_ID, sku_id=sku_id, data=TastingInput(tasted_on=TODAY)
        )

        summary = await summarize_tastings(session, user_id=USER_ID, sku_id=sku_id)

        assert summary.session_count == 2
        assert summary.rated_count == 1
        assert summary.average_rating == Decimal("4.00")

    async def test_기록이_없으면_None_을_반환한다(self, session: AsyncSession) -> None:
        summary = await summarize_tastings(session, user_id=USER_ID, sku_id=uuid.uuid4())

        assert summary.session_count == 0
        assert summary.average_rating is None
        assert summary.rating_change is None
        assert summary.total_poured_ml == 0

    async def test_다른_사용자의_기록은_섞이지_않는다(
        self, session: AsyncSession, bottle: Bottle
    ) -> None:
        sku_id = await _sku_id_of(session, bottle)
        await record_tasting(
            session,
            user_id=USER_ID,
            sku_id=sku_id,
            data=TastingInput(tasted_on=TODAY, rating=Decimal("4.0")),
        )
        await record_tasting(
            session,
            user_id=uuid.uuid4(),
            sku_id=sku_id,
            data=TastingInput(tasted_on=TODAY, rating=Decimal("1.0")),
        )

        summary = await summarize_tastings(session, user_id=USER_ID, sku_id=sku_id)
        assert summary.session_count == 1
        assert summary.average_rating == Decimal("4.00")


class TestTimeline:
    async def test_최근_순으로_반환한다(self, session: AsyncSession, bottle: Bottle) -> None:
        sku_id = await _sku_id_of(session, bottle)
        for offset in (0, 10, 20):
            await record_tasting(
                session,
                user_id=USER_ID,
                sku_id=sku_id,
                data=TastingInput(tasted_on=TODAY + datetime.timedelta(days=offset)),
            )

        timeline = await list_tastings(session, user_id=USER_ID, sku_id=sku_id)

        dates = [record.tasted_on for record in timeline]
        assert dates == sorted(dates, reverse=True)

    async def test_병으로_필터한다(self, session: AsyncSession, bottle: Bottle) -> None:
        sku_id = await _sku_id_of(session, bottle)
        await record_tasting(
            session,
            user_id=USER_ID,
            sku_id=sku_id,
            bottle=bottle,
            data=TastingInput(tasted_on=TODAY, poured_ml=30),
        )
        await record_tasting(
            session, user_id=USER_ID, sku_id=sku_id, data=TastingInput(tasted_on=TODAY)
        )

        by_bottle = await list_tastings(session, user_id=USER_ID, bottle_id=bottle.id)
        assert len(by_bottle) == 1

        by_sku = await list_tastings(session, user_id=USER_ID, sku_id=sku_id)
        assert len(by_sku) == 2
