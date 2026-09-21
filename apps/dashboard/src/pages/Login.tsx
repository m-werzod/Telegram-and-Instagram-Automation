import { useState } from 'react';
import { api, ApiError } from '../api';

export default function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/login', { login: loginName, password });
      onLoggedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed — please try again');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-glow login-glow-a" aria-hidden />
      <div className="login-glow login-glow-b" aria-hidden />

      <form className={`login-card${error ? ' shake' : ''}`} onSubmit={submit}>
        <div className="login-brand">
          <div className="login-logo" aria-hidden>
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              <circle cx="8.5" cy="11.5" r="0.5" fill="currentColor" />
              <circle cx="12" cy="11.5" r="0.5" fill="currentColor" />
              <circle cx="15.5" cy="11.5" r="0.5" fill="currentColor" />
            </svg>
          </div>
          <h1>AI Automation Platform</h1>
          <p>Instagram · Telegram · CRM — sign in to your control panel</p>
        </div>

        <label className="login-field">
          <span>Login</span>
          <div className="login-input">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            <input
              value={loginName}
              onChange={(e) => setLoginName(e.target.value)}
              placeholder="Your login"
              autoComplete="username"
              autoFocus
              required
            />
          </div>
        </label>

        <label className="login-field">
          <span>Password</span>
          <div className="login-input">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your password"
              autoComplete="current-password"
              required
            />
            <button
              type="button"
              className="login-eye"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              tabIndex={-1}
            >
              {showPassword ? (
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>
        </label>

        {error && (
          <div className="login-error" role="alert">
            {error}
          </div>
        )}

        <button className="login-submit" disabled={busy || !loginName || !password} type="submit">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="login-footnote">Protected area — authorized operators only</p>
      </form>
    </div>
  );
}
