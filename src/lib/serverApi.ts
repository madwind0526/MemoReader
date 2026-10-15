export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Thrown when the PC server cannot be reached at all (as opposed to answering with an error).
 * `detail` keeps what actually went wrong, so a failed background sync can be diagnosed.
 */
export class OfflineError extends Error {
  detail: string;
  constructor(message: string, detail = "") {
    super(message);
    this.detail = detail;
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      signal: AbortSignal.timeout(init.timeoutMs ?? 8000),
    });
  } catch (error) {
    throw new OfflineError("PC 서버에 연결할 수 없습니다.", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }

  const type = response.headers.get("content-type") ?? "";
  // A dev proxy or a captive page answers with HTML or a gateway error when the backend is down.
  if (!type.includes("application/json")) {
    throw new OfflineError("PC 서버에 연결할 수 없습니다.", `JSON이 아닌 응답 (HTTP ${response.status}, ${type || "형식 없음"})`);
  }
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new ApiError(response.status, payload.error ?? `요청에 실패했습니다 (${response.status}).`);
  return payload;
}
