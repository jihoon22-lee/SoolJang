/**
 * UUIDv7 생성. `uuidv7` 패키지를 얇게 감싼다.
 *
 * 손수 구현하지 않고 라이브러리를 쓰는 이유: 이 값은 PK 로 그대로 쓰인다
 * (`docs/architecture.md` §9.6). 타임스탬프·버전·variant 비트를 잘못 만들면 정렬성이
 * 깨지고, 그 버그가 곧바로 데이터 정합성 문제가 된다. 나머지 코드가 라이브러리에 직접
 * 묶이지 않도록 이 파일 하나로 교체 지점을 좁혀 둔다.
 */

import { uuidv7 } from "uuidv7";

export function newId(): string {
  return uuidv7();
}
