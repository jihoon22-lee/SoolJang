import { useMutation } from "@tanstack/react-query";
import { externalSourcesApi } from "@/api/client";
import type { ExternalOffer, SourceLookupResult } from "@/api/types";

const labels: Record<string, string> = {
  none: "없음",
  included: "포함",
  listed: "표시가",
  member: "회원가",
  recommended: "권장가",
  snippet: "검색 발췌",
  pickup: "픽업",
  delivery: "배송",
};
function condition(value: string | null) {
  return value === null ? "미확인" : (labels[value] ?? value);
}
function price(offer: ExternalOffer) {
  return `${Number(offer.amount).toLocaleString("ko-KR", { maximumFractionDigits: 4 })} ${offer.currency}`;
}

/** 같은 판본·규격·알려진 판매 조건에 한해서만 확인한 가격을 비교한다. */
export function OfferComparison({
  results,
  productId,
  offline,
  onChanged,
}: {
  results: SourceLookupResult[];
  productId: string;
  offline: boolean;
  onChanged: () => void;
}) {
  const preference = useMutation({
    mutationFn: ({ source, offer }: { source: SourceLookupResult; offer: ExternalOffer }) =>
      externalSourcesApi.pinMatch(productId, {
        source_id: source.source_id,
        external_url: offer.source_url,
        external_name: offer.name,
        external_key: offer.offer_key,
        external_product_key: offer.product_key,
        preferred_seller_key: offer.seller_key,
      }),
    onSuccess: onChanged,
  });
  const rows = results.flatMap((source) =>
    (source.offers ?? []).map((offer) => ({ source, offer })),
  );
  if (!rows.length) return null;
  const minima = new Map<string, number>();
  for (const { offer } of rows) {
    if (offer.comparison_group && !offer.needs_confirmation) {
      minima.set(
        offer.comparison_group,
        Math.min(minima.get(offer.comparison_group) ?? Infinity, Number(offer.amount)),
      );
    }
  }
  return (
    <section aria-label="판매 조건별 가격 비교">
      <h4>확인한 판매 조건 {rows.length}건</h4>
      {preference.isError && (
        <p role="alert" className="alert">
          선호 판매처를 저장하지 못했습니다.
        </p>
      )}
      <p className="muted text-sm">
        검색 응답에 포함된 판매처만 표시합니다. 조건이 미확인되거나 규격·판본이 다른 가격은 최저가
        비교에서 제외합니다.
      </p>
      <div className="table-scroll table-scroll--always">
        <table className="stats-table external-compare-table offer-compare-table">
          <thead>
            <tr>
              <th scope="col">판매처 / 상품</th>
              <th scope="col">가격 / 규격</th>
              <th scope="col">판매 조건</th>
              <th scope="col">확인 시각</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ source, offer }) => (
              <tr key={`${source.source_id}:${offer.condition_key}`}>
                <td>
                  <a href={offer.source_url} target="_blank" rel="noreferrer">
                    {offer.seller_name ?? "판매자 미확인"}
                  </a>
                  <div>
                    {source.source_name} · {offer.name}
                  </div>
                  {offer.branch && <div>{offer.branch}</div>}
                  {offer.seller_key && source.preferred_seller_key === offer.seller_key && (
                    <span className="badge">선호 판매처</span>
                  )}
                  {source.pinned && offer.seller_key && !offer.needs_confirmation && (
                    <button
                      type="button"
                      disabled={offline || preference.isPending}
                      onClick={() => preference.mutate({ source, offer })}
                    >
                      선호 판매처로 설정
                    </button>
                  )}
                </td>
                <td>
                  <strong>{price(offer)}</strong>
                  <div>
                    {offer.volume_ml === null ? "용량 미확인" : `${offer.volume_ml}ml`} ·{" "}
                    {offer.units === null ? "수량 미확인" : `${offer.units}개`}
                    {offer.is_set ? " 세트" : ""}
                  </div>
                  {offer.comparison_group &&
                    !offer.needs_confirmation &&
                    minima.get(offer.comparison_group) === Number(offer.amount) && (
                      <span className="badge">확인한 판매처 중 동일 조건 최저가</span>
                    )}
                  {offer.needs_confirmation && <span className="badge">제품·규격 확인 필요</span>}
                </td>
                <td>
                  {condition(offer.price_kind)} · {condition(offer.fulfillment)}
                  <div>
                    회원 조건: {condition(offer.membership)} / 쿠폰: {condition(offer.coupon)}
                  </div>
                  <div>
                    지역: {condition(offer.region)} / 배송비: {condition(offer.shipping)} / 세금:{" "}
                    {condition(offer.tax)}
                  </div>
                  <div>
                    재고: {offer.in_stock === null ? "미확인" : offer.in_stock ? "있음" : "없음"}
                  </div>
                </td>
                <td>
                  <time dateTime={offer.fetched_at}>
                    {new Date(offer.fetched_at).toLocaleString("ko-KR")}
                  </time>
                  {source.cached && <div>캐시 · 새 관측 아님</div>}
                  {offer.source_observed_at && <div>원문 시각: {offer.source_observed_at}</div>}
                  {offer.last_good && <div>최근 조회 실패 · 마지막 확인 가격</div>}
                  {source.degraded && <div>일부 수집 · 이전 판매 조건의 품절을 뜻하지 않음</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
