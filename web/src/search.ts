/**
 * 검색·자동완성 랭킹.
 *
 * 사용자 요청: "글" 을 치면 "글"로 시작하는 술이 위, "글"이 포함되기만 하는 술이 아래.
 * "글렌"이 되면 "글렌"으로 시작하는 것이 다시 우선. 검색창과 자동완성이 같은 규칙을 쓰도록
 * 여기 모은다 — `sync/queries.ts::matchesText` 는 예전엔 단순 `includes()` 라 순위가 없었다.
 *
 * 한글 초성 검색("ㄱㄹㄱㅇ" → "글렌고인")도 여기서 처리한다. 외부 의존성 없이 유니코드
 * 한글 음절(가~힣, U+AC00~U+D7A3) 분해 공식으로 구현한다.
 */

const CHOSUNG = [
  "ㄱ",
  "ㄲ",
  "ㄴ",
  "ㄷ",
  "ㄸ",
  "ㄹ",
  "ㅁ",
  "ㅂ",
  "ㅃ",
  "ㅅ",
  "ㅆ",
  "ㅇ",
  "ㅈ",
  "ㅉ",
  "ㅊ",
  "ㅋ",
  "ㅌ",
  "ㅍ",
  "ㅎ",
] as const;

const HANGUL_SYLLABLE_BASE = 0xac00;
const HANGUL_SYLLABLE_LAST = 0xd7a3;
//: 중성 21개 × 종성 28개 — 한 초성이 차지하는 음절 코드 범위.
const SYLLABLES_PER_CHOSUNG = 21 * 28;

/** 한글 음절을 초성으로 분해한다. 초성이 아닌 문자(영문·숫자·이미 자모인 문자)는 그대로 둔다. */
export function extractChosung(text: string): string {
  let result = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= HANGUL_SYLLABLE_BASE && code <= HANGUL_SYLLABLE_LAST) {
      const index = Math.floor((code - HANGUL_SYLLABLE_BASE) / SYLLABLES_PER_CHOSUNG);
      result += CHOSUNG[index];
    } else {
      result += ch;
    }
  }
  return result;
}

function isChosungOnly(text: string): boolean {
  if (text.length === 0) return false;
  return [...text].every((ch) => (CHOSUNG as readonly string[]).includes(ch));
}

/**
 * 제품 중복 판정용 정규화 키. 백엔드 `normalize_name_for_matching`(`legacy/normalize.py`)
 * 과 규칙을 맞춘다 — 공백·구두점·대소문자 차이를 제거해 같은 술이 다른 문자열로 갈리지
 * 않게 한다.
 */
export function normalizeNameForMatching(name: string): string {
  const lowered = name.trim().toLowerCase();
  const withoutPunctuation = lowered.replace(/[^0-9a-z가-힣\s　]+/g, " ");
  return withoutPunctuation.replace(/[\s　]+/g, " ").trim();
}

//: 이 문자 뒤는 "단어 시작"으로 친다. 접두사 다음으로 높은 순위.
const WORD_BOUNDARY = /[\s\-_·,./()]/;

/** 검색어가 후보 이름 안에서 몇 번째 순위로 일치하는지. 일치하지 않으면 `null`. */
function matchRank(haystack: string, needle: string): number | null {
  const index = haystack.indexOf(needle);
  if (index === -1) return null;
  if (index === 0) return 0; // 접두사
  if (WORD_BOUNDARY.test(haystack[index - 1] ?? "")) return 1; // 단어 시작
  return 2; // 부분 일치
}

/** `rankByQuery` 가 쓰는 것과 같은 규칙으로 일치 여부만 확인한다(초성 포함). */
export function matchesQuery(name: string, query: string): boolean {
  return rankOf(name, query) !== null;
}

function rankOf(name: string, query: string): number | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;

  if (isChosungOnly(needle)) {
    return matchRank(extractChosung(name), needle);
  }
  return matchRank(name.toLowerCase(), needle);
}

/**
 * 후보를 이름과 검색어로 랭킹한다: 접두사 > 단어 시작 > 부분 일치, 동순위는 이름순.
 * 검색어가 모두 한글 초성이면 후보 이름의 초성과 비교한다. 일치하지 않는 후보는 뺀다.
 */
export function rankByQuery<T>(
  items: readonly T[],
  query: string,
  nameOf: (item: T) => string,
): T[] {
  const needle = query.trim();
  if (!needle) return [...items];

  const scored: { item: T; rank: number; name: string }[] = [];
  for (const item of items) {
    const name = nameOf(item);
    const rank = rankOf(name, needle);
    if (rank === null) continue;
    scored.push({ item, rank, name });
  }

  scored.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.name.localeCompare(b.name)));
  return scored.map((s) => s.item);
}
