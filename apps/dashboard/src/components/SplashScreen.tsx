import { useEffect, useRef } from 'react';

/**
 * Shown once, between a successful login and the dashboard: the badge spins
 * in over a dark field, then hands over. Purely decorative — the dashboard
 * is already mounted and fetching behind it.
 */
export default function SplashScreen({
  onDone,
  duration = 2400,
}: {
  onDone: () => void;
  duration?: number;
}) {
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t = setTimeout(() => done.current(), prefersReduced ? 400 : duration);
    return () => clearTimeout(t);
  }, [duration]);

  return (
    <div className="splash" role="status" aria-label="Yuklanmoqda">
      <div className="splash-stage">
        <span className="splash-glow" aria-hidden />
        <img className="splash-mark" src="/logo.png" alt="Avtomaktab Turon" draggable={false} />
      </div>
      <div className="splash-title">Turon AI Platforma</div>
      <div className="splash-bar" aria-hidden>
        <span />
      </div>
    </div>
  );
}
