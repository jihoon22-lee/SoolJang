# 작업 계획과 진행 현황

**작업을 재개할 때 §1부터 읽는다.** 이 문서는 지금 진행 중인 일과 남은 결정만 담는다.
지난 릴리스·Task·결정 로그(D1~D225)는 [history.md](history.md), 동작 설계는
[architecture.md](architecture.md)·[external-data.md](external-data.md), 개발·검증 절차는
[development.md](development.md), 운영·배포는 [operations.md](operations.md)를 따른다.

> **갱신 규칙**: 모든 작업 PR은 §1(현재 위치), §2(진행 표), §4(결정), §5(열린 질문) 중 바뀐
> 부분을 **같은 PR**에서 갱신한다. 실제 검증 증거는 PR 묶음당 `workthrough/` 기록 하나에 모은다.

---

## 1. 현재 위치

| 항목 | 값 |
|---|---|
| 최종 갱신 | 2026-10-05 — v1.8.0 릴리스·운영 배포 완료([릴리스](https://github.com/jihoon22-lee/SoolJang/releases/tag/v1.8.0), [기록](../workthrough/2026-10-05-v180-release.md)) |
| 현재 마일스톤 | 없음. 직전 [v1.8.0](https://github.com/jihoon22-lee/SoolJang/milestone/2) 완료(메인 [#147](https://github.com/jihoon22-lee/SoolJang/issues/147)) |
| 진행 브랜치 | 없음. 새 작업은 `feature/<task-slug>` 로 시작한다 |
| 버전 | 코드·패키지 `1.8.0`, schema head `0019_record_event` |
| 운영 | API·웹 `1.8.0`, schema `0019_record_event`(2026-10-05 배포, 백업 `sooljang-20261005T062319028992Z-aad7df30`) |
| 이연 후속 | 국내 가격 2출처 실허용 사례 [#142](https://github.com/jihoon22-lee/SoolJang/issues/142), 실제 기기 푸시 수용 [#143](https://github.com/jihoon22-lee/SoolJang/issues/143) |

## 2. 직전 마일스톤: v1.8.0 (완료)

| 묶음 | 상태 | 근거 |
|---|---|---|
| ① 정확성 `feature/v180-correctness` | ✅ [#148](https://github.com/jihoon22-lee/SoolJang/pull/148) 머지 | [기록](../workthrough/2026-10-05-v180-correctness.md) |
| ② 일괄 처리 `feature/v180-bulk-records` | ✅ [#149](https://github.com/jihoon22-lee/SoolJang/pull/149) 머지 | [기록](../workthrough/2026-10-05-v180-bulk-records.md) |
| ③ 디자인·빠른 기록 `feature/v180-design` | ✅ [#150](https://github.com/jihoon22-lee/SoolJang/pull/150) 머지 | [기록](../workthrough/2026-10-05-v180-design.md) |
| ④ 부가 기능 `feature/v180-insights` | ✅ [#151](https://github.com/jihoon22-lee/SoolJang/pull/151) 머지 | [기록](../workthrough/2026-10-05-v180-insights.md) |
| ⑤ 문서 정리 `feature/v180-docs` | ✅ [#152](https://github.com/jihoon22-lee/SoolJang/pull/152) 머지 | [기록](../workthrough/2026-10-05-v180-docs.md) |
| ⑥ 직접 테스트 보강·릴리스 `feature/v180-release` | ✅ [#153](https://github.com/jihoon22-lee/SoolJang/pull/153) 머지, `v1.8.0` 태그·운영 배포 | [기록](../workthrough/2026-10-05-v180-release.md) |

## 3. 재개 절차

1. `git status -sb`, `git log --oneline -5`, 열린 PR과 원격 main을 대조한다. 미커밋 변경과
   진행 중 PR을 보존하고, 재개 작업은 기존 브랜치를 쓴다. 자동으로 main으로 바꾸지 않는다.
2. §1·§2 → 메인 이슈 → 관련 코드와 하위 `AGENTS.md` 순으로 읽는다.
3. 환경이 필요할 때만 [development.md](development.md) §1로 격리 DB·앱을 준비한다.
   이 기기의 Compose는 운영 스택이다.
4. [development.md](development.md) §2의 변경별 검증을 하고, 계획·구현·실검증·배포를 구분해
   `workthrough/`에 남긴다.

## 4. 결정(진행 중 마일스톤)

진행 중인 마일스톤이 없다. 다음 마일스톤의 결정은 D226부터 여기에 쓰고 릴리스 후
[history.md](history.md) §6으로 옮긴다. v1.8.0 결정(D212~D225)은 이미 옮겼다.

## 5. 열린 질문

| # | 질문 | 상태 |
|---|---|---|
| Q6 | 지인과 공유할 때의 권한 모델(읽기 전용 링크 vs 계정) | 미해결. 필요해지면 사용자와 정한다(D88) |
| Q3 | 외부 소스 추가 등록(이마트·트레이더스·코스트코·편의점 등) | 데일리샷 등록 완료. 나머지는 실제 응답 확인과 사용자 선택에 따른다([external-data.md](external-data.md)) |
| #142 | 국내 가격 2출처의 실제 허용 사례 | 사용자 승인 후속 |
| #143 | 실제 기기 웹 푸시 수용 | 사용자 승인 후속 |

지난 질문(Q1~Q9)의 결론은 [history.md](history.md) §4에 있다.
