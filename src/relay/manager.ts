import { getPool, upsertMetaMany } from "../db.js";
import { HttpError } from "../httpError.js";
import { loadRelayDialerConfig } from "./config.js";
import { createBoardFacade } from "./facade.js";
import { relayHttpUrl } from "./pairCode.js";
import { startEmbeddedRelay, type EmbeddedRelay, type RelayLog } from "./run.js";

const META_KEY = "relay_connection";
const BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SETTLE_MS = 8_000;

export type StoredRelay = {
  enabled: boolean;
  relayWsUrl: string;
  boardId: string;
  boardToken: string;
  boardLabel: string;
};

export type RelayStatus = "off" | "connecting" | "connected" | "reconnecting";

export type RelaySettingsView = {
  /** `settings` = saved in the board database, `env` = from process env, `none` = not configured. */
  source: "settings" | "env" | "none";
  enabled: boolean;
  relayWsUrl: string;
  boardId: string;
  boardLabel: string;
  hasToken: boolean;
  status: RelayStatus;
  lastError: string | null;
};

export type RelaySaveInput = {
  relayWsUrl?: unknown;
  boardId?: unknown;
  boardLabel?: unknown;
  /** Existing BOARD_TOKEN. Blank keeps the saved one for the same relay + board id. */
  boardToken?: unknown;
  /** One-time relay ADMIN_TOKEN: used to issue a scoped board token, never stored. */
  adminToken?: unknown;
};

type Deps = {
  loadStored: () => Promise<StoredRelay | null>;
  persist: (value: StoredRelay) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  start?: (opts: Parameters<typeof startEmbeddedRelay>[0]) => EmbeddedRelay;
  fetchImpl?: typeof fetch;
  log?: RelayLog;
  settleMs?: number;
};

function toEnv(value: StoredRelay): NodeJS.ProcessEnv {
  return {
    RELAY_WS_URL: value.relayWsUrl,
    BOARD_ID: value.boardId,
    BOARD_TOKEN: value.boardToken,
    BOARD_LABEL: value.boardLabel,
    RELAY_ENABLED: value.enabled ? "1" : "0",
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function friendlyError(message: string): string {
  if (message === "relay register rejected") return "中继拒绝了注册，请检查看板 ID 和令牌是否匹配。";
  return message;
}

export function createRelayManager(deps: Deps) {
  const envSource = deps.env ?? process.env;
  const start = deps.start ?? startEmbeddedRelay;
  const doFetch = deps.fetchImpl ?? fetch;
  const baseLog: RelayLog = deps.log ?? ((level, message) => console[level === "info" ? "log" : level](`[relay] ${message}`));
  const settleMs = deps.settleMs ?? SETTLE_MS;

  let stored: StoredRelay | null = null;
  let current: EmbeddedRelay | null = null;
  let generation = 0;
  let status: RelayStatus = "off";
  let lastError: string | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  }

  function effectiveEnv(): NodeJS.ProcessEnv {
    return stored ? toEnv(stored) : envSource;
  }

  async function stop(): Promise<void> {
    generation += 1;
    const old = current;
    current = null;
    status = "off";
    if (old) await old.close().catch(() => undefined);
  }

  async function dial(): Promise<void> {
    await stop();
    lastError = null;
    const config = loadRelayDialerConfig(effectiveEnv());
    if (!config.enabled) {
      baseLog(config.level, config.reason);
      return;
    }
    const mine = ++generation;
    status = "connecting";
    const log: RelayLog = (level, message) => {
      baseLog(level, message);
      if (mine === generation && level !== "info") lastError = friendlyError(message);
    };
    const relay = start({
      config,
      facade: createBoardFacade(),
      log,
      onSession: (session) => {
        if (mine !== generation) return;
        if (session === null) {
          if (status === "connected") status = "reconnecting";
        } else if (status === "reconnecting") {
          status = "connected";
        }
      },
    });
    current = relay;
    relay.ready.then(
      () => {
        if (mine !== generation) return;
        status = "connected";
        lastError = null;
      },
      () => {
        if (mine === generation && status === "connecting") status = "reconnecting";
      },
    );
  }

  async function settle(): Promise<void> {
    const relay = current;
    if (!relay) return;
    await Promise.race([
      relay.ready.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, settleMs).unref()),
    ]);
  }

  async function issueBoardToken(adminToken: string, relayWsUrl: string, boardId: string): Promise<string> {
    if (/[\r\n]/.test(adminToken)) throw new HttpError(400, "请输入有效的中继管理员令牌。");
    let response: Response;
    try {
      response = await doFetch(relayHttpUrl(relayWsUrl, "/auth/board/issue"), {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ boardIds: [boardId], rotate: false }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new HttpError(502, "无法连接中继，请检查中继地址和网络。");
    }
    if (response.status === 401) throw new HttpError(401, "中继管理员令牌无效。");
    if (response.status === 429) throw new HttpError(429, "请求过于频繁，请稍后重试。");
    if (!response.ok) throw new HttpError(502, "中继无法签发看板令牌，请稍后重试。");
    const body: unknown = await response.json().catch(() => null);
    const token = body && typeof body === "object" && "boardToken" in body ? (body as { boardToken: unknown }).boardToken : null;
    if (typeof token !== "string" || !/^bt_[A-Za-z0-9_-]{20,}$/.test(token)) {
      throw new HttpError(502, "中继返回了无效的看板令牌。");
    }
    return token;
  }

  function view(): RelaySettingsView {
    if (stored) {
      return {
        source: "settings",
        enabled: stored.enabled,
        relayWsUrl: stored.relayWsUrl,
        boardId: stored.boardId,
        boardLabel: stored.boardLabel,
        hasToken: Boolean(stored.boardToken),
        status,
        lastError,
      };
    }
    const config = loadRelayDialerConfig(envSource);
    if (config.enabled) {
      return {
        source: "env",
        enabled: true,
        relayWsUrl: config.relayWsUrl,
        boardId: config.boardId,
        boardLabel: config.boardLabel,
        hasToken: true,
        status,
        lastError,
      };
    }
    return { source: "none", enabled: false, relayWsUrl: "", boardId: "", boardLabel: "", hasToken: false, status: "off", lastError: null };
  }

  return {
    effectiveEnv,
    settings: view,

    /** Load saved settings and dial. Never throws. */
    init(): Promise<void> {
      return serial(async () => {
        try {
          stored = await deps.loadStored();
        } catch (err) {
          baseLog("error", `could not load saved relay settings (${err instanceof Error ? err.message : "unknown"})`);
          stored = null;
        }
        await dial();
      });
    },

    save(input: RelaySaveInput): Promise<RelaySettingsView> {
      return serial(async () => {
        const relayWsUrl = text(input.relayWsUrl);
        const boardId = text(input.boardId);
        const boardLabel = text(input.boardLabel) || boardId;
        if (!relayWsUrl) throw new HttpError(400, "请填写中继地址。");
        if (!boardId) throw new HttpError(400, "请填写看板 ID。");
        if (!BOARD_ID.test(boardId)) throw new HttpError(400, "看板 ID 以字母或数字开头，只能包含字母、数字、点、下划线和短横线，最长 64 字符。");
        if (boardLabel.length > 80) throw new HttpError(400, "看板名称最长 80 个字符。");
        let url: URL;
        try {
          url = new URL(relayWsUrl);
        } catch {
          throw new HttpError(400, "中继地址不是有效的 URL。");
        }
        if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new HttpError(400, "中继地址必须以 ws:// 或 wss:// 开头。");
        if (url.username || url.password) throw new HttpError(400, "中继地址不能包含账号密码。");

        const adminToken = text(input.adminToken);
        let boardToken = text(input.boardToken);
        if (adminToken) boardToken = await issueBoardToken(adminToken, url.toString(), boardId);
        else if (!boardToken && stored && stored.boardId === boardId && stored.relayWsUrl === url.toString()) boardToken = stored.boardToken;
        if (!boardToken) throw new HttpError(400, "请填写中继管理员令牌（自动注册），或填写已有的看板令牌。");
        if (/[\r\n]/.test(boardToken)) throw new HttpError(400, "看板令牌格式无效。");

        const next: StoredRelay = { enabled: true, relayWsUrl: url.toString(), boardId, boardLabel, boardToken };
        const check = loadRelayDialerConfig(toEnv(next));
        if (!check.enabled) throw new HttpError(400, check.reason);
        await deps.persist(next);
        stored = next;
        await dial();
        await settle();
        return view();
      });
    },

    /** Stop dialing but keep the saved settings, so it can be turned back on without re-entering them. */
    disconnect(): Promise<RelaySettingsView> {
      return serial(async () => {
        if (stored) {
          const next = { ...stored, enabled: false };
          await deps.persist(next);
          stored = next;
        }
        await dial();
        return view();
      });
    },

    close(): Promise<void> {
      return serial(stop);
    },
  };
}

export const relayManager = createRelayManager({
  async loadStored() {
    const res = await getPool().query<{ value: string }>(`SELECT value FROM meta WHERE key = $1`, [META_KEY]);
    const raw = res.rows[0]?.value;
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o.relayWsUrl !== "string" || typeof o.boardId !== "string" || typeof o.boardToken !== "string") return null;
    return {
      enabled: o.enabled !== false,
      relayWsUrl: o.relayWsUrl,
      boardId: o.boardId,
      boardToken: o.boardToken,
      boardLabel: typeof o.boardLabel === "string" && o.boardLabel ? o.boardLabel : o.boardId,
    };
  },
  async persist(value) {
    await upsertMetaMany([[META_KEY, JSON.stringify(value)]]);
  },
});

