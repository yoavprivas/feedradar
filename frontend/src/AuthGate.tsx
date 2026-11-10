import { useEffect, useState, type FormEvent, type ReactNode } from "react";

export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<{
    required: boolean;
    authenticated: boolean;
  } | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function check() {
    try {
      const response = await fetch("/api/auth/session");
      if (!response.ok) throw new Error();
      setSession(await response.json());
      setError("");
    } catch {
      setError("לא ניתן להתחבר לשרת. נסו שוב.");
    }
  }
  useEffect(() => {
    void check();
    const expired = () => {
      setSession({ required: true, authenticated: false });
      setError("הכניסה פגה. יש להיכנס מחדש.");
    };
    window.addEventListener("feedradar-unauthorized", expired);
    return () => window.removeEventListener("feedradar-unauthorized", expired);
  }, []);
  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-FeedRadar-Request": "1",
        },
        body: JSON.stringify({ password }),
      });
      setPassword("");
      if (!response.ok) {
        setError(
          response.status === 429
            ? "בוצעו יותר מדי ניסיונות. נסו שוב בעוד 15 דקות."
            : "הכניסה נכשלה. בדקו את הסיסמה ונסו שוב.",
        );
        return;
      }
      await check();
    } catch {
      setError("לא ניתן להתחבר לשרת. נסו שוב.");
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-FeedRadar-Request": "1",
        },
        body: "{}",
      });
      if (!response.ok) throw new Error();
      setSession({ required: true, authenticated: false });
    } catch {
      setError("ההתנתקות נכשלה. נסו שוב.");
    }
  }
  if (session?.authenticated)
    return (
      <>
        {session.required && (
          <div className="auth-toolbar">
            <button className="button button-secondary" onClick={logout}>
              יציאה
            </button>
            {error && <span role="alert">{error}</span>}
          </div>
        )}
        {children}
      </>
    );
  return (
    <main className="login-panel" dir="rtl">
      <img src="/logo-mark.svg" alt="" width="56" height="56" />
      <h1>כניסה ל־FeedRadar</h1>
      {!session ? (
        <>
          <p>מתחברים לשרת…</p>
          {error && (
            <button className="button button-secondary" onClick={check}>
              ניסיון נוסף
            </button>
          )}
        </>
      ) : (
        <form onSubmit={login}>
          <label className="field-label" htmlFor="admin-password">
            סיסמת מנהל
          </label>
          <input
            id="admin-password"
            className="url-input"
            type="password"
            autoComplete="current-password"
            dir="ltr"
            required
            maxLength={256}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className="button button-primary" disabled={busy}>
            {busy ? "מתחברים…" : "כניסה"}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </main>
  );
}
