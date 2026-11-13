import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle, Stethoscope, XCircle } from 'lucide-react';
import { api, ApiError } from '../api';

/**
 * "Instagram javob bermayapti" — why?
 *
 * Every precondition for an Instagram comment or DM to be answered, checked
 * live and shown with its evidence and its fix.
 *
 * This exists because that question used to be unanswerable from the
 * dashboard. Instagram has no polling mode: a customer's message arrives only
 * if Meta can POST it here, and Meta only does that while the account is
 * subscribed. When it was not, the connection still read "connected" (the
 * token was perfectly valid), no banner fired, and the Logs page showed
 * nothing — so the whole channel was dead with every indicator green. One
 * button now answers it instead of a day of guessing.
 */
interface Check {
  id: string;
  title: string;
  state: 'pass' | 'fail' | 'warn' | 'unknown';
  detail: string;
  fix?: string;
}

interface Diagnosis {
  ok: boolean;
  summary: string;
  checks: Check[];
}

const ICONS = {
  pass: { Icon: CheckCircle2, cls: 'ok' },
  warn: { Icon: AlertTriangle, cls: 'warn' },
  fail: { Icon: XCircle, cls: 'bad' },
  unknown: { Icon: HelpCircle, cls: 'accent' },
} as const;

export default function InstagramDiagnostics() {
  const [result, setResult] = useState<Diagnosis | null>(null);
  const run = useMutation({
    mutationFn: () => api.get<Diagnosis>('/api/connections/instagram/diagnose'),
    onSuccess: setResult,
  });

  return (
    <div className="card">
      <h3>
        <Stethoscope size={16} />
        Instagram nega javob bermayapti?
      </h3>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Instagram'da "polling" yo'q — har bir izoh va har bir Direct faqat Meta shu serverga
        o'zi yuborganda keladi. Token to'g'ri bo'lsa ham yetarli emas. Quyidagi tekshiruv
        xabar kelishi uchun kerak bo'lgan HAMMA shartni jonli tekshiradi.
      </p>

      <button className="small" onClick={() => run.mutate()} disabled={run.isPending}>
        <Stethoscope size={13} />
        {run.isPending ? 'Tekshirilmoqda…' : 'Tekshirishni boshlash'}
      </button>

      {run.isError && (
        <div className="error-text">
          {run.error instanceof ApiError ? run.error.message : 'Tekshirib bo‘lmadi'}
        </div>
      )}

      {result && (
        <>
          <div
            className={result.ok ? 'success-text' : 'error-text'}
            style={{ marginTop: 12, fontWeight: 600 }}
          >
            {result.summary}
          </div>
          <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
            {result.checks.map((check) => {
              const { Icon, cls } = ICONS[check.state];
              return (
                <div key={check.id} className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
                  <span className={`badge ${cls}`} style={{ marginTop: 2 }}>
                    <Icon size={12} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>{check.title}</div>
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      {check.detail}
                    </div>
                    {check.fix && (
                      <div style={{ fontSize: 12.5, marginTop: 3 }}>
                        <strong>Nima qilish kerak:</strong> {check.fix}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
