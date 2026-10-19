/**
 * 화면 보기 상태(기간·탭·정렬)를 같은 탭 세션 안에서 보존한다.
 *
 * 통계의 근거를 눌러 제품 상세로 갔다가 돌아오면 화면이 새로 마운트되어 기간·탭이 기본값으로
 * 돌아갔다. 제품 목록(`productListState.ts`)처럼 계정별 sessionStorage 에 둔다. 입력 기록이 아니라
 * 보기 설정이라 탭을 닫으면 사라져도 된다.
 */
import { type Dispatch, type SetStateAction, useState } from "react";
import { databaseIdentity } from "@/sync/db";

const key = (owner: string, name: string) => `sooljang:view:${owner}:${name}`;

/** 저장값이 기본값과 같은 모양일 때만 쓴다(구버전·손상 값은 기본값으로 시작). */
function sameShape<T>(value: unknown, fallback: T): value is T {
  if (typeof value !== typeof fallback || value === null) return false;
  if (typeof fallback !== "object" || fallback === null) return true;
  if (Array.isArray(fallback) !== Array.isArray(value)) return false;
  return Object.entries(fallback).every(
    ([field, item]) => typeof (value as Record<string, unknown>)[field] === typeof item,
  );
}

export function readViewState<T>(name: string, fallback: T, allowed?: readonly T[]): T {
  const owner = databaseIdentity().userId;
  if (!owner) return fallback;
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(key(owner, name)) ?? "null");
    if (!sameShape(stored, fallback)) return fallback;
    if (allowed && !allowed.includes(stored)) return fallback;
    return stored;
  } catch {
    return fallback;
  }
}

export function useViewState<T>(
  name: string,
  initial: T,
  allowed?: readonly T[],
): [T, Dispatch<SetStateAction<T>>] {
  const [owner] = useState(() => databaseIdentity().userId);
  const [value, setValue] = useState<T>(() => readViewState(name, initial, allowed));
  const update: Dispatch<SetStateAction<T>> = (next) => {
    setValue((previous) => {
      const resolved = typeof next === "function" ? (next as (prev: T) => T)(previous) : next;
      // 계정이 바뀐 뒤 늦게 도착한 갱신은 새 계정 키에 쓰지 않는다.
      if (owner && owner === databaseIdentity().userId) {
        try {
          sessionStorage.setItem(key(owner, name), JSON.stringify(resolved));
        } catch {
          /* 저장소를 못 쓰면 화면 상태만 유지한다. */
        }
      }
      return resolved;
    });
  };
  return [value, update];
}
