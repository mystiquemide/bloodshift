// Client for the Zetaris HTTP query API. All reads in the app go through here.

export class ZetarisError extends Error {
  constructor(
    message: string,
    readonly kind: "unreachable" | "auth" | "query",
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ZetarisError";
  }
}

export interface QueryResult {
  rows: Record<string, string | number | boolean | null>[];
  // When Zetaris returned the result, used as evidence on every row
  queriedAt: string;
  // Time Zetaris reports spending on the query, in milliseconds
  engineMs: number | null;
}

export interface ZetarisOptions {
  baseUrl: string;
  username: string;
  password: string;
  orgId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface Session {
  token: string;
  orgId: string;
}

export class ZetarisClient {
  private session: Session | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: ZetarisOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async query(sql: string, limit = 10_000): Promise<QueryResult> {
    try {
      return await this.runQuery(sql, limit);
    } catch (err) {
      // A stale token is the common failure after a Zetaris restart. Log in again once.
      if (err instanceof ZetarisError && err.kind === "auth" && this.session) {
        this.session = null;
        return this.runQuery(sql, limit);
      }
      throw err;
    }
  }

  private async runQuery(sql: string, limit: number): Promise<QueryResult> {
    const session = await this.login();
    const res = await this.post(
      "/api/proxy/sql-editor/sqls/run-query",
      { sql, limit },
      { Authorization: `Bearer ${session.token}`, "X-Org-ID": session.orgId },
    );
    const body = await readJson(res);
    if (res.status === 401 || res.status === 403) {
      throw new ZetarisError("Zetaris rejected the session", "auth", res.status);
    }
    if (!res.ok) {
      throw new ZetarisError(`Zetaris query failed: ${errorText(body)}`, "query", res.status);
    }
    return toResult(body);
  }

  private async login(): Promise<Session> {
    if (this.session) return this.session;
    const res = await this.post("/api/auth/login", {
      username: this.opts.username,
      password: this.opts.password,
    });
    const body = await readJson(res);
    if (!res.ok) throw new ZetarisError(`Zetaris login failed: ${errorText(body)}`, "auth", res.status);
    const login = body as { idToken?: string; orgId?: string | number };
    if (!login.idToken) throw new ZetarisError("Zetaris login returned no token", "auth", res.status);
    const orgId = this.opts.orgId || (login.orgId !== undefined ? String(login.orgId) : "");
    if (!orgId) throw new ZetarisError("No Zetaris organisation ID. Set ZETARIS_ORG_ID", "auth");
    this.session = { token: login.idToken, orgId };
    return this.session;
  }

  private async post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    try {
      return await this.fetchImpl(new URL(path, this.opts.baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ZetarisError(`Can't reach Zetaris at ${this.opts.baseUrl}`, "unreachable", undefined, { cause: err });
    }
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function errorText(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 300);
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const msg = b.message ?? b.error ?? b.detail;
    if (typeof msg === "string") return msg.slice(0, 300);
    return JSON.stringify(body).slice(0, 300);
  }
  return "no response body";
}

function toResult(body: unknown): QueryResult {
  const b = body as { headers?: unknown; data?: unknown; timeUsed?: unknown };
  if (!Array.isArray(b?.headers) || !Array.isArray(b?.data)) {
    throw new ZetarisError("Zetaris returned an unexpected result shape", "query");
  }
  const headers = b.headers.map(String);
  const rows = b.data.map((row) => {
    if (!Array.isArray(row)) throw new ZetarisError("Zetaris returned a malformed row", "query");
    return Object.fromEntries(headers.map((h, i) => [h, row[i] ?? null]));
  });
  return {
    rows,
    queriedAt: new Date().toISOString(),
    engineMs: typeof b.timeUsed === "number" ? b.timeUsed : null,
  };
}
