/**
 * `outbox.ts` → `engine.ts` 알림용 이벤트 버스.
 *
 * `outbox.ts` 가 `engine.ts` 를 직접 import 해서 동기화를 트리거하면 순환 참조가
 * 생긴다(엔진이 outbox 를 읽어 flush 하므로). 이벤트로 느슨하게 연결한다.
 */

export const syncEvents = new EventTarget();
export const OUTBOX_CHANGED = "outbox-changed";
