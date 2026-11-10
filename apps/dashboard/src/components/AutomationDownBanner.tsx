import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, KeyRound, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../api';

/**
 * "The automation is not answering anybody" — said where it cannot be missed.
 *
 * This exists because of a real four-day outage. An OpenAI key expired; the
 * platform noticed within minutes, verified it, and raised a task saying
 * exactly that — on the Manual Actions page, which nobody opens. From the
 * outside it looked like Instagram had broken, and the diagnosis took a full
 * investigation to re-derive something the platform already knew.
 *
 * So the verdict goes on every page, for every role, and it leads with the
 * number that matters: how many real customers went unanswered.
 */

interface ChannelProblem {
  channel: 'INSTAGRAM' | 'TELEGRAM';
  displayName: string;
  healthStatus: string;
  detail: string;
}

interface AiStatus {
  ok: boolean;
  keyRejected: boolean;
  failed24h: number;
  succeeded24h: number;
  strandedMessages: number;
  lastError: string | null;
  since: string | null;
  channels?: ChannelProblem[];
}

export default function AutomationDownBanner({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['ai-status'],
    queryFn: () => api.get<AiStatus>('/api/ai-status'),
    // Frequent enough that a fixed key clears the banner on its own, cheap
    // enough to cost nothing: it is four counts.
    refetchInterval: 60_000,
    retry: false,
  });

  const replay = useMutation({
    mutationFn: () => api.post<{ replayed: number }>('/api/dead-letters/replay', { withinHours: 72 }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-status'] }),
  });

  const s = status.data;
  if (!s || s.ok) return null;

  const since = s.since ? new Date(s.since).toLocaleString('uz-UZ') : null;
  const channels = s.channels ?? [];
  // A dead channel token is the more urgent of the two: the AI can be perfect
  // and still reach nobody, so the channel outage is what the banner leads with.
  const channelsDown = channels.length > 0;

  return (
    <div className="down-banner" role="alert">
      <AlertTriangle size={20} />
      <div className="down-body">
        <strong>
          {channelsDown
            ? `${channels.map((c) => (c.channel === 'INSTAGRAM' ? 'Instagram' : 'Telegram')).join(' va ')} ulanishi uzilgan — javob yuborib bo‘lmaydi`
            : s.keyRejected
              ? 'AI kaliti ishlamayapti — hech kimga javob berilmayapti'
              : 'AI javob bera olmayapti'}
        </strong>
        <div className="down-detail">
          {channelsDown ? (
            <>
              {channels.map((c) => (
                <div key={c.channel} style={{ marginBottom: 4 }}>
                  <strong>{c.displayName}</strong> — {c.detail || c.healthStatus}
                </div>
              ))}
              Tokenni yangilang: <strong>Ulanishlar</strong> sahifasida akkauntni qayta ulang.
              Gaplashuvlar kelayotgan bo‘lsa ham, javob yuborilmaydi.
            </>
          ) : s.keyRejected ? (
            <>
              AI provayderi saqlangan kalitni rad etmoqda, shuning uchun{' '}
              <strong>Instagram ham, Telegram ham</strong> javob bermaydi. Bu Instagram nosozligi
              emas — xabarlar kelyapti, faqat javob yozilmayapti.
            </>
          ) : (
            <>
              So‘nggi 24 soatda {s.failed24h} ta urinish muvaffaqiyatsiz, hech biri o‘tmadi.
            </>
          )}
          {s.strandedMessages > 0 && (
            <>
              {' '}
              <strong>{s.strandedMessages} ta mijoz xabari javobsiz qoldi.</strong>
            </>
          )}
          {since && <span className="muted"> (boshlangan: {since})</span>}
        </div>

        {s.lastError && <div className="down-error mono">{s.lastError}</div>}

        {isAdmin && (
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <Link to={channelsDown ? '/connections' : '/settings'} className="btn small">
              <KeyRound size={13} />
              {channelsDown ? 'Ulanishlar sahifasi' : 'Kalitni almashtirish'}
            </Link>
            {s.strandedMessages > 0 && (
              <button
                className="small"
                disabled={replay.isPending || s.keyRejected || channelsDown}
                title={
                  s.keyRejected || channelsDown
                    ? 'Avval ulanish va kalitni tiklang — hozir qayta yuborish yana xato beradi'
                    : 'Javobsiz qolgan xabarlarni qayta ishlash'
                }
                onClick={() => replay.mutate()}
              >
                <RefreshCw size={13} className={replay.isPending ? 'spin' : ''} />
                {replay.isPending
                  ? 'Yuborilmoqda…'
                  : `${s.strandedMessages} ta xabarni qayta ishlash`}
              </button>
            )}
          </div>
        )}

        {replay.isSuccess && (
          <p className="success-text" style={{ margin: '8px 0 0', fontSize: 12.5 }}>
            {replay.data.replayed} ta xabar navbatga qaytarildi.
          </p>
        )}
        {replay.isError && (
          <div className="error-text" style={{ fontSize: 12.5 }}>
            {replay.error instanceof ApiError ? replay.error.message : 'Qayta ishlab bo‘lmadi'}
          </div>
        )}
      </div>
    </div>
  );
}
