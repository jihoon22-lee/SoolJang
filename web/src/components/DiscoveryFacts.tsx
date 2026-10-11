import type { DiscoverySource } from "@/api/discovery";
import { publicLink } from "@/discovery/useDiscovery";

export function DiscoveryFacts({ result }: { result: DiscoverySource }) {
  const fields: Record<string, unknown> = {
    ...result.fields,
    ...result.applicable_fields,
    volume_ml: result.normalized.volume_ml ?? result.fields.volume_ml,
  };
  const labels = {
    name_en: "원어명",
    producer: "생산자",
    country: "국가",
    region: "지역",
    abv: "도수 %",
    vintage: "빈티지",
    age_years: "숙성 연수",
    volume_ml: "용량 ml",
  };
  const url = result.source_url && publicLink(result.source_url);
  return (
    <dl className="discovery-facts">
      {Object.entries(labels).map(([key, label]) => {
        const value = fields[key];
        const text =
          typeof value === "string" || typeof value === "number" ? String(value) : "미확인";
        return (
          <div key={key}>
            <dt>{label}</dt>
            <dd>
              {url && text !== "미확인" ? (
                <a href={url} target="_blank" rel="noreferrer" aria-label={`${label} ${text} 출처`}>
                  {text}
                </a>
              ) : (
                text
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
