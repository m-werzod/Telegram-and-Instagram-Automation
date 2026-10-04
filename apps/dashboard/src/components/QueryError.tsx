import { AlertTriangle, RotateCcw } from 'lucide-react';

/**
 * Banner for a failed data load. Without it a failed query renders as an
 * empty list, which reads as "no data" and hides real outages.
 */
export default function QueryError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="card" style={{ borderColor: '#f3c2c2', background: '#fff6f6' }}>
      <div className="row" style={{ gap: 9, alignItems: 'flex-start' }}>
        <AlertTriangle size={18} color="#d93939" style={{ flexShrink: 0, marginTop: 2 }} />
        <div style={{ flex: 1 }}>
          <strong>Ma'lumotni yuklab bo'lmadi</strong>
          <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
            {error instanceof Error ? error.message : "Noma'lum xatolik"}
          </div>
        </div>
        {onRetry && (
          <button className="small" onClick={onRetry}>
            <RotateCcw size={13} /> Qayta urinish
          </button>
        )}
      </div>
    </div>
  );
}
