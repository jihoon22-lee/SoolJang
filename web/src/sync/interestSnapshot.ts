/**
 * 매장 모드용 관심 목록 읽기 저장본.
 *
 * 관심은 서버 조회 전용이라(오프라인 쓰기는 이연) 통신이 나쁜 매장에서는 볼 수 없었다. 마지막으로
 * 온라인에서 받은 관심·목표가를 계정 DB의 `sync_meta` 에 한 덩어리로 두고, 오프라인에서는 저장
 * 시각과 함께 읽기 전용으로 보여 준다. 저장본으로 쓰기나 감시 판단을 하지 않는다.
 */

import { useLiveQuery } from "dexie-react-hooks";
import type { Interest } from "@/api/interests";
import type { PriceWatch } from "@/api/priceWatch";
import { databaseIdentity, db } from "@/sync/db";

const KEY = "interest-snapshot";

export interface SnapshotInterest {
  id: string;
  name: string;
  nameEn: string | null;
  aliases: string[];
  volumesMl: number[];
  /** 활성 감시의 목표가. 같은 관심에 여러 판매 조건이 있으면 모두 둔다. */
  targets: { amount: string; currency: string; source: string }[];
}

export interface InterestSnapshot {
  savedAt: string;
  interests: SnapshotInterest[];
}

/** 보관·삭제하지 않은 관심만 남긴다. 매장에서 볼 것은 "다음에 살 술"이다. */
export function buildInterestSnapshot(
  interests: readonly Interest[],
  watches: readonly PriceWatch[],
  now: Date,
): InterestSnapshot {
  return {
    savedAt: now.toISOString(),
    interests: interests
      .filter((row) => !row.archived && !row.deleted)
      .map((row) => ({
        id: row.id,
        name: row.name,
        nameEn: row.identity.name_en ?? null,
        aliases: row.identity.search_aliases ?? [],
        volumesMl: row.identity.volumes_ml ?? [],
        targets: watches
          .filter(
            (watch) =>
              watch.interest_id === row.id && watch.is_active && watch.criteria.target_amount,
          )
          .map((watch) => ({
            amount: String(watch.criteria.target_amount),
            currency: watch.criteria.currency,
            source: watch.source_name,
          })),
      })),
  };
}

export async function saveInterestSnapshot(snapshot: InterestSnapshot): Promise<void> {
  await db.sync_meta.put({ key: KEY, value: JSON.stringify(snapshot) });
}

function parseSnapshot(raw: string | undefined): InterestSnapshot | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<InterestSnapshot>;
    return typeof value.savedAt === "string" && Array.isArray(value.interests)
      ? (value as InterestSnapshot)
      : null;
  } catch {
    return null;
  }
}

/** 이 계정의 마지막 저장본. 없거나 모양이 다르면 null. */
export function useInterestSnapshot(): InterestSnapshot | null | undefined {
  const userId = databaseIdentity().userId;
  return useLiveQuery(async () => parseSnapshot((await db.sync_meta.get(KEY))?.value), [userId]);
}
