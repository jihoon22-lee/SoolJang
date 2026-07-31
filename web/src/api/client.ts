/**
 * 백엔드 API 클라이언트.
 *
 * 서버는 RFC 9457 Problem Details 로 에러를 반환한다. `ApiError` 가 이를 그대로 보존해
 * 폼이 어느 입력에 오류를 표시할지 알 수 있게 한다.
 */

import type {
  Bottle,
  CategoryTree,
  DeleteStrategy,
  FieldError,
  HealthStatus,
  ImportAnalysis,
  ImportCommitResult,
  ProblemDetail,
  Product,
  ProductCreateInput,
  ProductFilters,
  ProductPage,
  Purchase,
  PurchaseCreateInput,
  Vendor,
} from "@/api/types";

export const API_PREFIX = "/api/v1";

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

  const response = await fetch(`${API_PREFIX}${path}${buildQuery(params)}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
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
    throw new ApiError(response.status, message, problem);
  }

  return payload as T;
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
async function upload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append("file", file);

  const response = await fetch(`${API_PREFIX}${path}`, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: form,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
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
