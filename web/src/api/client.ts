/**
 * 백엔드 API 클라이언트.
 *
 * 서버는 RFC 9457 Problem Details 로 에러를 반환한다. `ApiError` 가 이를 그대로 보존해
 * 폼이 어느 입력에 오류를 표시할지 알 수 있게 한다.
 */

import type {
  AttachmentKind,
  AttachmentResponse,
  BarcodeLookupResponse,
  Bottle,
  CategoryStat,
  CategoryTree,
  DeleteStrategy,
  FieldError,
  HealthStatus,
  ImportAnalysis,
  ImportCommitResult,
  LabelExtractionResponse,
  LlmSettingInput,
  LlmSettingResponse,
  LoginResponse,
  ProblemDetail,
  Product,
  ProductCreateInput,
  ProductFilters,
  ProductPage,
  Purchase,
  PurchaseCreateInput,
  Rankings,
  SetupStatus,
  Sku,
  StatsSummary,
  SyncBatchResponse,
  SyncOperationRequest,
  SyncPullResponse,
  Tasting,
  TastingInput,
  TastingSummary,
  User,
  Vendor,
} from "@/api/types";

export const API_PREFIX = "/api/v1";

/** CSRF 토큰 쿠키 이름. 서버(`api/routes/auth.py`)와 같아야 한다. */
const CSRF_COOKIE = "sooljang_csrf";
const CSRF_HEADER = "X-CSRF-Token";

/**
 * 쿠키에서 CSRF 토큰을 읽는다.
 *
 * 세션 토큰은 `httpOnly` 라 JavaScript 가 읽을 수 없지만, CSRF 토큰은 헤더에 실어야 하므로
 * 읽을 수 있게 두었다(double-submit cookie).
 */
function readCsrfToken(): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

type UnauthorizedHandler = () => void;

let onUnauthorized: UnauthorizedHandler | null = null;

/**
 * 세션이 만료됐을 때 호출할 콜백을 등록한다.
 *
 * 각 화면이 401 을 개별로 처리하면 빠뜨리는 곳이 생긴다. 클라이언트 한 곳에서 잡아
 * 로그인 화면으로 되돌린다.
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

export class ApiError extends Error {
  readonly status: number;
  readonly problem: ProblemDetail | null;

  constructor(status: number, message: string, problem: ProblemDetail | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.problem = problem;
  }

  /** 필드별 오류. 폼이 각 입력 아래에 메시지를 붙일 수 있다. */
  get fieldErrors(): FieldError[] {
    return this.problem?.errors ?? [];
  }

  errorFor(field: string): string | undefined {
    return this.fieldErrors.find((error) => error.field === field)?.message;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** 이 상태 코드는 오류로 던지지 않고 본문을 그대로 반환한다. */
  acceptStatuses?: number[];
}

function buildQuery(params: RequestOptions["params"]): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, params, signal, acceptStatuses = [] } = options;

  const csrfToken = readCsrfToken();
  const needsCsrf = method !== "GET" && method !== "HEAD";

  const response = await fetch(`${API_PREFIX}${path}${buildQuery(params)}`, {
    method,
    // 세션 쿠키를 실어야 인증이 통과한다. 기본값 `same-origin` 으로도 되지만 의도를 명시한다.
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(needsCsrf && csrfToken ? { [CSRF_HEADER]: csrfToken } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = await parseJson(response);

  if (!response.ok && !acceptStatuses.includes(response.status)) {
    const problem = isProblemDetail(payload) ? payload : null;
    const message =
      problem?.detail ?? problem?.title ?? `요청이 실패했습니다 (HTTP ${response.status})`;
    notifyIfUnauthorized(response.status, path);
    throw new ApiError(response.status, message, problem);
  }

  return payload as T;
}

/**
 * 401 이면 세션 만료를 알린다.
 *
 * 로그인 요청 자체의 401 은 "비밀번호가 틀렸다"는 뜻이므로 세션 만료로 다루면 안 된다.
 * 로그인 화면이 직접 메시지를 보여준다.
 */
function notifyIfUnauthorized(status: number, path: string): void {
  if (status !== 401) return;
  if (path.startsWith("/auth/login") || path.startsWith("/auth/setup")) return;
  onUnauthorized?.();
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isProblemDetail(value: unknown): value is ProblemDetail {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "title" in value &&
    "status" in value
  );
}

// --- 헬스체크 ---------------------------------------------------------------

/**
 * 서비스 상태를 조회한다.
 *
 * DB 장애 시 503 과 함께 본문을 반환하므로 오류로 던지지 않는다. 상태 표시 화면 자체가
 * 사라지면 원인을 알 수 없다.
 */
export function fetchHealth(signal?: AbortSignal): Promise<HealthStatus> {
  return request<HealthStatus>("/health", { acceptStatuses: [503], ...(signal ? { signal } : {}) });
}

// --- 카테고리 ---------------------------------------------------------------

export const categoriesApi = {
  tree: (signal?: AbortSignal) => request<CategoryTree>("/categories", signal ? { signal } : {}),

  create: (input: { name: string; parent_id?: string | null; sort_order?: number }) =>
    request<unknown>("/categories", { method: "POST", body: input }),

  rename: (id: string, name: string) =>
    request<unknown>(`/categories/${id}`, { method: "PATCH", body: { name } }),

  reparent: (id: string, newParentId: string | null) =>
    request<CategoryTree>(`/categories/${id}:reparent`, {
      method: "POST",
      body: { new_parent_id: newParentId },
    }),

  reorder: (items: { id: string; sort_order: number }[]) =>
    request<CategoryTree>("/categories:reorder", { method: "POST", body: { items } }),

  merge: (id: string, targetId: string) =>
    request<CategoryTree>(`/categories/${id}:merge`, {
      method: "POST",
      body: { target_id: targetId },
    }),

  resetSeed: () => request<CategoryTree>("/categories:reset-seed", { method: "POST" }),

  remove: (id: string, strategy: DeleteStrategy = "reject", targetId?: string) =>
    request<CategoryTree>(`/categories/${id}`, {
      method: "DELETE",
      params: { strategy, target_id: targetId },
    }),
};

// --- 제품 -------------------------------------------------------------------

export const productsApi = {
  list: (filters: ProductFilters & { cursor?: string | null }, signal?: AbortSignal) =>
    request<ProductPage>("/products", {
      params: { ...filters, cursor: filters.cursor ?? undefined },
      ...(signal ? { signal } : {}),
    }),

  get: (id: string, signal?: AbortSignal) =>
    request<Product>(`/products/${id}`, signal ? { signal } : {}),

  create: (input: ProductCreateInput) =>
    request<Product>("/products", { method: "POST", body: input }),

  update: (id: string, input: Partial<ProductCreateInput>) =>
    request<Product>(`/products/${id}`, { method: "PATCH", body: input }),

  remove: (id: string) => request<void>(`/products/${id}`, { method: "DELETE" }),

  addSku: (id: string, volumeMl: number) =>
    request<unknown>(`/products/${id}/skus`, { method: "POST", body: { volume_ml: volumeMl } }),
};

export const skusApi = {
  update: (id: string, input: { volume_ml?: number; barcode?: string | null }) =>
    request<Sku>(`/skus/${id}`, { method: "PATCH", body: input }),
};

// --- 구매처·구매 건 ---------------------------------------------------------

export const vendorsApi = {
  list: (signal?: AbortSignal) => request<Vendor[]>("/vendors", signal ? { signal } : {}),

  create: (input: { name: string; kind?: string }) =>
    request<Vendor>("/vendors", { method: "POST", body: input }),
};

export const purchasesApi = {
  list: (params: { product_id?: string; sku_id?: string }, signal?: AbortSignal) =>
    request<Purchase[]>("/purchases", { params, ...(signal ? { signal } : {}) }),

  create: (input: PurchaseCreateInput) =>
    request<Purchase>("/purchases", { method: "POST", body: input }),

  remove: (id: string) => request<void>(`/purchases/${id}`, { method: "DELETE" }),

  bottles: (id: string, signal?: AbortSignal) =>
    request<Bottle[]>(`/purchases/${id}/bottles`, signal ? { signal } : {}),

  split: (id: string, parts: { quantity: number; vendor_id?: string | null }[]) =>
    request<Purchase[]>(`/purchases/${id}:split`, { method: "POST", body: { parts } }),
};

// --- 레거시 임포트 ----------------------------------------------------------

/**
 * 파일 업로드는 multipart 이므로 JSON 요청 헬퍼를 쓸 수 없다. Content-Type 을 직접 지정하면
 * boundary 가 빠져 서버가 파싱하지 못하므로 브라우저가 붙이도록 둔다.
 */
async function upload<T>(
  path: string,
  file: File,
  fields: Record<string, string> = {},
): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }

  const csrfToken = readCsrfToken();
  const response = await fetch(`${API_PREFIX}${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(csrfToken ? { [CSRF_HEADER]: csrfToken } : {}),
    },
    body: form,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    notifyIfUnauthorized(response.status, path);
    const problem = isProblemDetail(payload) ? payload : null;
    throw new ApiError(
      response.status,
      problem?.detail ?? problem?.title ?? `업로드가 실패했습니다 (HTTP ${response.status})`,
      problem,
    );
  }
  return payload as T;
}

export const importsApi = {
  /** DB 를 건드리지 않고 적재될 내용만 계산한다. */
  analyze: (file: File) => upload<ImportAnalysis>("/imports/legacy:analyze", file),
  commit: (file: File) => upload<ImportCommitResult>("/imports/legacy:commit", file),
};

// --- 인증 --------------------------------------------------------------------

export const authApi = {
  /** 초기 설정이 필요한지. 로그인 화면이 어떤 폼을 보여줄지 결정한다. */
  setupStatus: (signal?: AbortSignal) =>
    request<SetupStatus>("/auth/setup", signal ? { signal } : {}),

  setup: (input: { email: string; password: string; display_name: string }) =>
    request<LoginResponse>("/auth/setup", { method: "POST", body: input }),

  login: (input: { email: string; password: string }) =>
    request<LoginResponse>("/auth/login", { method: "POST", body: input }),

  logout: () => request<void>("/auth/logout", { method: "POST" }),

  /** 현재 사용자. 401 이면 로그인되지 않은 상태다. */
  me: (signal?: AbortSignal) => request<User>("/auth/me", signal ? { signal } : {}),

  changePassword: (input: { current_password: string; new_password: string }) =>
    request<void>("/auth/password", { method: "POST", body: input }),
};

// --- 병과 시음 ----------------------------------------------------------------

/** 병 상태 전이. 상태·잔량·날짜가 얽혀 있어 서버가 함께 갱신한다. */
export const bottlesApi = {
  list: (params: { status?: string; in_stock?: boolean }, signal?: AbortSignal) =>
    request<Bottle[]>("/bottles", { params, ...(signal ? { signal } : {}) }),

  get: (id: string, signal?: AbortSignal) =>
    request<Bottle>(`/bottles/${id}`, signal ? { signal } : {}),

  open: (id: string, body: { opened_on?: string; remaining_ml?: number } = {}) =>
    request<Bottle>(`/bottles/${id}:open`, { method: "POST", body }),

  finish: (id: string, body: { finished_on?: string } = {}) =>
    request<Bottle>(`/bottles/${id}:finish`, { method: "POST", body }),

  gift: (id: string, body: { on?: string; note?: string } = {}) =>
    request<Bottle>(`/bottles/${id}:gift`, { method: "POST", body }),

  sell: (id: string, body: { on?: string; note?: string } = {}) =>
    request<Bottle>(`/bottles/${id}:sell`, { method: "POST", body }),

  /** 잘못 눌렀을 때 되돌리기. 기록을 지우지 않고 상태만 개봉으로 바꾼다. */
  reopen: (id: string) => request<Bottle>(`/bottles/${id}:reopen`, { method: "POST" }),

  tastings: (id: string, signal?: AbortSignal) =>
    request<Tasting[]>(`/bottles/${id}/tastings`, signal ? { signal } : {}),
};

export const tastingsApi = {
  create: (input: TastingInput) => request<Tasting>("/tastings", { method: "POST", body: input }),

  list: (params: { sku_id?: string; bottle_id?: string }, signal?: AbortSignal) =>
    request<Tasting[]>("/tastings", { params, ...(signal ? { signal } : {}) }),

  summary: (params: { sku_id?: string; bottle_id?: string }, signal?: AbortSignal) =>
    request<TastingSummary>("/tastings/summary", { params, ...(signal ? { signal } : {}) }),

  remove: (id: string) => request<void>(`/tastings/${id}`, { method: "DELETE" }),
};

export const statsApi = {
  rankings: (params: { limit?: number } = {}, signal?: AbortSignal) =>
    request<Rankings>("/stats/rankings", { params, ...(signal ? { signal } : {}) }),

  byCategory: (signal?: AbortSignal) =>
    request<CategoryStat[]>("/stats/by-category", signal ? { signal } : {}),

  summary: (signal?: AbortSignal) =>
    request<StatsSummary>("/stats/summary", signal ? { signal } : {}),
};

/** 오프라인 동기화. `sync/engine.ts` 만 직접 호출한다 — 나머지 코드는 outbox 를 거친다. */
export const syncApi = {
  pull: (since: string | null, signal?: AbortSignal) =>
    request<SyncPullResponse>("/sync", {
      params: { since: since ?? undefined },
      ...(signal ? { signal } : {}),
    }),

  batch: (operations: SyncOperationRequest[]) =>
    request<SyncBatchResponse>("/sync/batch", { method: "POST", body: { operations } }),

  resolveConflict: (conflictId: string) =>
    request<void>(`/sync/conflicts/${conflictId}:resolve`, { method: "POST" }),
};

/** 바코드 스캔 매칭(Task 16). 카메라·외부 조회 모두 온라인 전용이라 outbox 를 거치지
 * 않는다 — 오프라인이면 스캔 버튼 자체를 감춘다. */
export const barcodesApi = {
  lookup: (code: string, signal?: AbortSignal) =>
    request<BarcodeLookupResponse>(`/barcodes/${encodeURIComponent(code)}`, {
      ...(signal ? { signal } : {}),
    }),
};

/** LLM 설정(Task 17). API 키 원문은 절대 오지 않는다 — 저장 응답에도 마스킹된 값뿐이다. */
export const llmSettingsApi = {
  get: (signal?: AbortSignal) =>
    request<LlmSettingResponse>("/llm-settings", signal ? { signal } : {}),

  save: (input: LlmSettingInput) =>
    request<LlmSettingResponse>("/llm-settings", { method: "PUT", body: input }),

  remove: () => request<void>("/llm-settings", { method: "DELETE" }),
};

/** 라벨 OCR(Task 17). Vision LLM 호출이라 온라인 전용이다 — outbox 를 거치지 않는다.
 * 아무것도 저장하지 않는다 — 결과를 검수한 뒤 평소처럼 `productsApi.create` 로 저장한다. */
export const ocrApi = {
  extractLabel: (file: File) => upload<LabelExtractionResponse>("/ocr/label", file),
};

/** 첨부파일 업로드(Task 10 문서 갭을 Task 17 에서 채움). 지금은 이미지만 받는다. */
export const attachmentsApi = {
  create: (
    file: File,
    meta: {
      kind: AttachmentKind;
      product_id?: string;
      bottle_id?: string;
      tasting_session_id?: string;
    },
  ) =>
    upload<AttachmentResponse>("/attachments", file, {
      kind: meta.kind,
      ...(meta.product_id ? { product_id: meta.product_id } : {}),
      ...(meta.bottle_id ? { bottle_id: meta.bottle_id } : {}),
      ...(meta.tasting_session_id ? { tasting_session_id: meta.tasting_session_id } : {}),
    }),
};
