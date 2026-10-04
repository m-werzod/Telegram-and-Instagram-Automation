import { useState } from 'react';
import { User, Lock, Eye, EyeOff, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '../api';
import BrandLogo from '../components/BrandLogo';

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
      setError(err instanceof ApiError ? "Login yoki parol noto'g'ri" : 'Xatolik yuz berdi — qayta urinib ko\'ring');
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
          <BrandLogo size={72} className="login-mark" />
          <h1>Turon AI Platforma</h1>
          <p>Instagram · Telegram · CRM — boshqaruv panelingizga kiring</p>
        </div>

        <label className="login-field">
          <span>Login</span>
          <div className="login-input">
            <User size={17} strokeWidth={1.8} aria-hidden />
            <input
              value={loginName}
              onChange={(e) => setLoginName(e.target.value)}
              placeholder="Loginingizni kiriting"
              autoComplete="username"
              autoFocus
              required
            />
          </div>
        </label>

        <label className="login-field">
          <span>Parol</span>
          <div className="login-input">
            <Lock size={17} strokeWidth={1.8} aria-hidden />
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Parolingizni kiriting"
              autoComplete="current-password"
              required
            />
            <button
              type="button"
              className="login-eye"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Parolni yashirish' : "Parolni ko'rsatish"}
              tabIndex={-1}
            >
              {showPassword ? <EyeOff size={17} strokeWidth={1.8} /> : <Eye size={17} strokeWidth={1.8} />}
            </button>
          </div>
        </label>

        {error && (
          <div className="login-error" role="alert">
            <ShieldAlert size={16} strokeWidth={2} />
            {error}
          </div>
        )}

        <button className="login-submit" disabled={busy || !loginName || !password} type="submit">
          {busy ? 'Kirilmoqda…' : 'Kirish'}
        </button>

        <p className="login-footnote">
          <ShieldCheck size={13} strokeWidth={2} />
          Himoyalangan hudud — faqat vakolatli foydalanuvchilar uchun
        </p>
      </form>
    </div>
  );
}
