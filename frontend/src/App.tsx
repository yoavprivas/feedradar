import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import copy from "./copy.json";
import { Icon } from "./Icons";

type Source = {
  id: string;
  name: string;
  site_url: string;
  last_checked_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  article_count: number;
  collection_status: "pending" | "empty" | "ready" | "error";
};
type Article = {
  id: string;
  title: string;
  url: string;
  published_at: string | null;
  source_name: string;
};
type ScanResult = {
  added: number;
  succeeded: number;
  failed: number;
  checked: number;
};
type State = {
  schedulerMode: "local" | "external";
  sources: Source[];
  scanning: boolean;
  lastFinishedAt: string | null;
  nextScanAt: string | null;
  intervalMinutes: number;
  lastResult: ScanResult | null;
};
type Feed = { articles: Article[]; total: number };
type Notice = { kind: "success" | "error" | "warning"; text: string } | null;
const c = (
  key: keyof typeof copy,
  values: Record<string, string | number> = {},
) =>
  Object.entries(values).reduce(
    (s, [k, v]) => s.replaceAll(`{${k}}`, String(v)),
    copy[key],
  );
const formatDate = (value: string) =>
  new Intl.DateTimeFormat("he-IL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
class ApiError extends Error {}
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-FeedRadar-Request": "1",
      ...options.headers,
    },
  });
  if (!response.ok) {
    if (response.status === 401)
      window.dispatchEvent(new Event("feedradar-unauthorized"));
    const data = await response.json().catch(() => ({}));
    throw new ApiError(data.error ?? "SERVER_ERROR");
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
function message(error: unknown) {
  if (error instanceof ApiError && error.message === "NETWORK_ERROR")
    return c("add.unreachable");
  const code = error instanceof ApiError ? error.message : "NETWORK_ERROR";
  const map: Record<string, keyof typeof copy> = {
    INVALID_URL: "add.invalidUrl",
    UNSAFE_URL: "add.notPublic",
    DUPLICATE_SITE: "add.duplicate",
    UNSUPPORTED_SITE: "add.unsupported",
    ACCESS_DENIED: "add.blocked",
    ROBOTS_DENIED: "add.blocked",
    TIMEOUT: "add.timeout",
    RATE_LIMITED: "add.rateLimited",
    INVALID_FEED: "add.invalidFeed",
    RESPONSE_TOO_LARGE: "add.tooLarge",
    SOURCE_UNAVAILABLE: "add.unreachable",
    NETWORK_ERROR: "common.networkError",
    SERVER_ERROR: "common.serverError",
    STORAGE_ERROR: "common.serverError",
    NOT_FOUND: "remove.notFound",
    SOURCE_CHANGED: "site.invalidFeed",
  };
  if (code === "REFRESH_COOLDOWN")
    return "כדי לא להעמיס על האתרים, יש להמתין מעט לפני רענון נוסף.";
  if (code === "SCAN_IN_PROGRESS") return c("feed.refreshInProgress");
  if (code === "ADD_IN_PROGRESS")
    return "בדיקת אתר כבר מתבצעת. כדאי להמתין לסיומה.";
  if (code === "SOURCE_LIMIT")
    return "אפשר לעקוב אחרי עד 50 אתרים בגרסה המקומית.";
  return c(map[code] ?? "common.serverError");
}
export function App() {
  const [tab, setTab] = useState<"feed" | "sites">(() =>
    location.hash === "#sites" ? "sites" : "feed",
  );
  const [state, setState] = useState<State | null>(null);
  const [feed, setFeed] = useState<Feed>({ articles: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [url, setUrl] = useState("");
  const [addError, setAddError] = useState("");
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [more, setMore] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const loadedCount = useRef(50);
  const requestVersion = useRef(0);
  const load = useCallback(async (quiet = false) => {
    const version = ++requestVersion.current;
    if (!quiet) setLoading(true);
    try {
      const [nextState, pages] = await Promise.all([
        api<State>("/state"),
        Promise.all(
          Array.from({ length: Math.ceil(loadedCount.current / 50) }, (_, i) =>
            api<Feed>(`/feed?limit=50&offset=${i * 50}`),
          ),
        ),
      ]);
      const nextFeed = {
        total: pages[0].total,
        articles: [
          ...new Map(
            pages.flatMap((p) => p.articles).map((a) => [a.id, a]),
          ).values(),
        ],
      };
      if (version !== requestVersion.current) return;
      setState(nextState);
      setFeed(nextFeed);
      loadedCount.current = Math.max(50, nextFeed.articles.length);
      setLoadError(false);
    } catch {
      if (version === requestVersion.current) setLoadError(true);
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden && !adding && !refreshing && !more) void load(true);
    }, 15000);
    return () => clearInterval(timer);
  }, [load, adding, refreshing, more]);
  useEffect(() => {
    const handler = () => setTab(location.hash === "#sites" ? "sites" : "feed");
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  useEffect(() => {
    if (addError && !adding) input.current?.focus();
  }, [addError, adding]);
  function navigate(next: "feed" | "sites") {
    setTab(next);
    location.hash = next;
    setNotice(null);
  }
  async function add(event: FormEvent) {
    event.preventDefault();
    if (adding) return;
    if (!url.trim()) {
      setAddError(c("add.required"));
      input.current?.focus();
      return;
    }
    setAdding(true);
    setAddError("");
    setNotice(null);
    try {
      const result = await api<{ added: number; collectionStatus: string }>(
        "/sources",
        {
          method: "POST",
          body: JSON.stringify({ url }),
        },
      );
      setUrl("");
      setNotice({
        kind: result.collectionStatus === "error" ? "warning" : "success",
        text:
          result.collectionStatus === "error"
            ? "האתר נוסף למעקב, אך שמירת הכתבות נכשלה. ננסה שוב בסריקה הבאה."
            : result.collectionStatus === "empty"
              ? "האתר נוסף למעקב. האיסוף הסתיים ללא כתבות חדשות."
              : c(result.added ? "add.successWithArticles" : "add.success"),
      });
      await load(true);
    } catch (error) {
      setAddError(message(error));
      input.current?.focus();
    } finally {
      setAdding(false);
    }
  }
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setNotice(null);
    try {
      const result = await api<ScanResult>("/refresh", {
        method: "POST",
        body: "{}",
      });
      const key = result.failed
        ? result.succeeded
          ? "feed.refreshPartial"
          : "feed.refreshFailed"
        : result.added === 1
          ? "feed.refreshSuccessOne"
          : result.added
            ? "feed.refreshSuccess"
            : "feed.refreshNoNew";
      setNotice({
        kind: result.failed ? "warning" : "success",
        text: c(key, { count: result.added }),
      });
      await load(true);
    } catch (error) {
      setNotice({ kind: "error", text: message(error) });
    } finally {
      setRefreshing(false);
    }
  }
  async function remove(id: string) {
    setRemoving(id);
    setNotice(null);
    try {
      await api(`/sources/${id}`, { method: "DELETE" });
      setConfirmId(null);
      setNotice({ kind: "success", text: c("remove.success") });
      await load(true);
      listHeading.current?.focus();
    } catch (error) {
      setNotice({ kind: "error", text: message(error) });
    } finally {
      setRemoving(null);
    }
  }
  async function loadMore() {
    setMore(true);
    const version = ++requestVersion.current;
    try {
      const next = await api<Feed>(
        `/feed?limit=50&offset=${feed.articles.length}`,
      );
      if (version !== requestVersion.current) return;
      setFeed((previous) => ({
        total: next.total,
        articles: [
          ...new Map(
            [...previous.articles, ...next.articles].map((a) => [a.id, a]),
          ).values(),
        ],
      }));
      loadedCount.current = feed.articles.length + next.articles.length;
    } catch {
      setNotice({ kind: "error", text: c("feed.moreError") });
    } finally {
      setMore(false);
    }
  }
  const busy = refreshing || !!state?.scanning;
  const failed = state?.sources.filter((s) => s.last_error).length ?? 0;
  return (
    <div className="app-shell">
      <a href="#main" className="skip-link">
        {c("nav.skip")}
      </a>
      <aside className="sidebar">
        <a className="brand" href="#feed" aria-label="FeedRadar">
          <img src="/logo-mark.svg" className="brand-mark" alt="" />
          <span className="brand-name" dir="ltr">
            FeedRadar
          </span>
        </a>
        <p className="brand-tagline">{c("app.tagline")}</p>
        <nav className="main-nav" aria-label={c("nav.label")}>
          <button
            className={`nav-item ${tab === "feed" ? "is-active" : ""}`}
            aria-current={tab === "feed" ? "page" : undefined}
            onClick={() => navigate("feed")}
          >
            <Icon name="feed" />
            {c("nav.feed")}
          </button>
          <button
            className={`nav-item ${tab === "sites" ? "is-active" : ""}`}
            aria-current={tab === "sites" ? "page" : undefined}
            onClick={() => navigate("sites")}
          >
            <Icon name="sites" />
            {c("nav.sites")}
            {state && <span className="nav-count">{state.sources.length}</span>}
          </button>
        </nav>
        <div className="sidebar-footer">
          <Icon name="clock" />
          <p>
            {state?.schedulerMode === "external"
              ? "הסריקות מופעלות באמצעות מתזמן חיצוני."
              : c("schedule.localNote")}
          </p>
        </div>
      </aside>
      <main id="main" className="main-content" tabIndex={-1}>
        <header className="page-header">
          <div className="page-heading">
            <span className="eyebrow" dir="ltr">
              FEEDRADAR / {tab === "feed" ? "YOUR FEED" : "YOUR SOURCES"}
            </span>
            <h1 className="page-title">
              {c(tab === "feed" ? "feed.title" : "sites.title")}
            </h1>
            <p className="page-description">
              {c(tab === "feed" ? "feed.subtitle" : "sites.subtitle")}
            </p>
          </div>
          <div className="page-actions">
            {tab === "feed" ? (
              <button
                className="button button-secondary"
                disabled={busy || !state?.sources.length || loadError}
                onClick={refresh}
              >
                <Icon name="refresh" className={busy ? "spinner" : ""} />
                {c(busy ? "feed.refreshing" : "feed.refresh")}
              </button>
            ) : (
              <button
                className="button button-secondary"
                onClick={() => navigate("feed")}
              >
                <Icon name="arrow" />
                {c("sites.backToFeed")}
              </button>
            )}
          </div>
        </header>
        {notice && (
          <div
            className={`notice notice-${notice.kind}`}
            role={notice.kind === "error" ? "alert" : "status"}
          >
            <Icon name={notice.kind === "success" ? "check" : "alert"} />
            <span>{notice.text}</span>
            <button
              className="notice-close icon-button"
              onClick={() => setNotice(null)}
              aria-label={c("common.dismiss")}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
        {loadError && (
          <div className="notice notice-error" role="alert">
            <Icon name="alert" />
            <span>{c("common.networkError")}</span>
            <button className="button button-secondary" onClick={() => load()}>
              {c("common.retry")}
            </button>
          </div>
        )}
        {!loadError && failed > 0 && !notice && (
          <div className="notice notice-warning" role="status">
            <Icon name="alert" />
            <span>
              {c(
                failed === state?.sources.length
                  ? "feed.refreshFailed"
                  : "feed.refreshPartial",
              )}
            </span>
            {tab === "feed" && (
              <button
                className="button button-secondary"
                onClick={() => navigate("sites")}
              >
                {c("nav.sites")}
              </button>
            )}
          </div>
        )}
        {loading && !state ? (
          <section className="feed-panel loading-state" aria-busy="true">
            <p>{c("feed.loading")}</p>
            {[1, 2, 3].map((n) => (
              <div className="skeleton" key={n} />
            ))}
          </section>
        ) : !state && loadError ? null : tab === "feed" ? (
          <section className="feed-panel" aria-label={c("nav.feed")}>
            <div className="panel-header">
              <h2 className="panel-title">
                {c("feed.articleCount", { count: feed.total })}
              </h2>
              <span className="panel-meta">
                {state?.lastFinishedAt
                  ? c("feed.lastCheck", {
                      time: formatDate(state.lastFinishedAt),
                    })
                  : c("feed.notChecked")}
              </span>
            </div>
            {!feed.articles.length ? (
              <div className="empty-state">
                <img src="/logo-mark.svg" alt="" className="empty-icon" />
                <h2 className="empty-title">
                  {c(
                    state?.sources.length
                      ? "feed.emptyArticlesTitle"
                      : "feed.emptySitesTitle",
                  )}
                </h2>
                <p className="empty-description">
                  {c(
                    state?.sources.length
                      ? "feed.emptyArticlesBody"
                      : "feed.emptySitesBody",
                  )}
                </p>
                <button
                  className="button button-primary"
                  disabled={loadError || busy}
                  onClick={() =>
                    state?.sources.length ? refresh() : navigate("sites")
                  }
                >
                  <Icon name={state?.sources.length ? "refresh" : "plus"} />
                  {c(
                    state?.sources.length
                      ? "feed.emptyArticlesAction"
                      : "feed.emptySitesAction",
                  )}
                </button>
              </div>
            ) : (
              <ul className="article-list">
                {feed.articles.map((article) => (
                  <li className="article-row" key={article.id}>
                    <a
                      className="article-link"
                      href={article.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`${article.title} — ${article.source_name} — ${article.published_at ? formatDate(article.published_at) : c("article.noDate")} — ${c("article.opensNewTab")}`}
                    >
                      <div className="article-content">
                        <h2 className="article-title" dir="auto">
                          {article.title}
                        </h2>
                        <span className="article-source" dir="auto">
                          {article.source_name}
                        </span>
                      </div>
                      <div className="article-date">
                        {article.published_at ? (
                          <time dateTime={article.published_at} dir="ltr">
                            {formatDate(article.published_at)}
                          </time>
                        ) : (
                          <span>{c("article.noDate")}</span>
                        )}
                        <Icon name="external" className="external-icon" />
                      </div>
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {feed.articles.length < feed.total && (
              <div className="feed-footer">
                <button
                  className="button button-secondary"
                  onClick={loadMore}
                  disabled={more}
                >
                  {c(more ? "feed.moreLoading" : "feed.more")}
                </button>
              </div>
            )}
          </section>
        ) : (
          <>
            <section className="add-source-panel" aria-labelledby="add-title">
              <h2 id="add-title" className="panel-title">
                {c("add.title")}
              </h2>
              <p className="field-hint" id="url-help">
                {c("add.help")}
              </p>
              <form className="add-source-form" onSubmit={add} noValidate>
                <div className="field">
                  <label className="field-label" htmlFor="site-url">
                    {c("add.urlLabel")}
                  </label>
                  <input
                    ref={input}
                    id="site-url"
                    className="url-input"
                    type="url"
                    inputMode="url"
                    autoComplete="url"
                    spellCheck={false}
                    dir="ltr"
                    placeholder={c("add.urlPlaceholder")}
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      setAddError("");
                    }}
                    aria-invalid={!!addError}
                    aria-describedby={
                      addError ? "url-help url-error" : "url-help"
                    }
                    disabled={adding}
                    maxLength={2048}
                  />
                </div>
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={adding || loadError}
                >
                  <Icon
                    name={adding ? "refresh" : "plus"}
                    className={adding ? "spinner" : ""}
                  />
                  {c(adding ? "add.checking" : "add.submit")}
                </button>
              </form>
              {addError && (
                <p className="field-error" id="url-error" role="alert">
                  {addError}
                </p>
              )}
            </section>
            <section className="sources-panel">
              <div className="panel-header">
                <h2 className="panel-title" ref={listHeading} tabIndex={-1}>
                  {c("sites.count", { count: state?.sources.length ?? 0 })}
                </h2>
              </div>
              {!state?.sources.length ? (
                <div className="empty-state">
                  <Icon name="sites" size={40} />
                  <h3 className="empty-title">{c("sites.emptyTitle")}</h3>
                  <p className="empty-description">{c("sites.emptyBody")}</p>
                </div>
              ) : (
                <ul className="source-list">
                  {state.sources.map((source) => (
                    <li className="source-row" key={source.id}>
                      <div className="source-info">
                        <div className="source-heading">
                          <h3 className="source-name" dir="auto">
                            {source.name}
                          </h3>
                          <span
                            className={`source-status ${source.last_error ? "is-error" : ""}`}
                          >
                            <span className="status-dot" />
                            במעקב ·{" "}
                            {
                              {
                                pending: "ממתין לאיסוף",
                                empty: "טרם נאספו כתבות",
                                ready: "כתבות נאספו",
                                error: "האיסוף נכשל",
                              }[source.collection_status]
                            }
                          </span>
                        </div>
                        <a
                          className="source-url"
                          href={source.site_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          dir="ltr"
                        >
                          {source.site_url}
                        </a>
                        <div className="source-meta">
                          <span>
                            {c("site.articleCount", {
                              count: source.article_count,
                            })}
                          </span>
                          {source.last_checked_at && (
                            <span>
                              {c("site.lastAttempt", {
                                time: formatDate(source.last_checked_at),
                              })}
                            </span>
                          )}
                        </div>
                        {source.last_error && (
                          <p className="field-error">
                            {message(new ApiError(source.last_error))}
                          </p>
                        )}
                      </div>
                      <div className="source-actions">
                        {confirmId === source.id ? (
                          <div className="remove-confirmation">
                            <strong>{c("remove.title")}</strong>
                            <p>{c("remove.body")}</p>
                            <div className="inline-actions">
                              <button
                                className="button button-danger"
                                disabled={!!removing}
                                onClick={() => remove(source.id)}
                              >
                                {c(
                                  removing
                                    ? "remove.pending"
                                    : "remove.confirm",
                                )}
                              </button>
                              <button
                                className="button button-secondary"
                                disabled={!!removing}
                                onClick={() => setConfirmId(null)}
                              >
                                {c("remove.cancel")}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            className="button button-danger"
                            aria-label={c("site.removeLabel", {
                              name: source.name,
                            })}
                            onClick={() => setConfirmId(source.id)}
                          >
                            <Icon name="trash" />
                            {c("site.remove")}
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
        {state && !loadError && (
          <footer className="schedule-note">
            <Icon name="clock" />
            <span>
              {c("schedule.interval", { minutes: state.intervalMinutes })}
            </span>
            {state.nextScanAt && (
              <span>
                {c("schedule.nextCheck", {
                  time: formatDate(state.nextScanAt),
                })}
              </span>
            )}
          </footer>
        )}
      </main>
    </div>
  );
}
