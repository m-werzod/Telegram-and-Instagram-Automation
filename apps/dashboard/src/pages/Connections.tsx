import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plug, Send, RefreshCw } from 'lucide-react';
import { api, type Connection } from '../api';
import IconChip from '../components/IconChip';
import QueryError from '../components/QueryError';
import InstagramIcon from '../components/InstagramIcon';
import ChannelAccountCard from '../components/ChannelAccountCard';

export { HealthBadge } from '../components/ChannelAccountCard';

/** Token help shared with the handover page so both say the same thing. */
export const INSTAGRAM_TOKEN_HINT =
  'Uzun muddatli Instagram token qo\'ying. Eng tez yo\'l: Meta App Dashboard → Instagram → "API setup with Instagram business login" → Generate token (60 kun amal qiladi; platforma avtomatik yangilaydi).';
export const TELEGRAM_TOKEN_HINT =
  "Telegramda @BotFather orqali bot yarating (/newbot) va tokenni shu yerga qo'ying. Platforma uni tekshiradi va webhook/polling'ni avtomatik sozlaydi.";
export const INSTAGRAM_SWITCH_HINT =
  "Yangi akkaunt Instagram ilovasida professional (Business/Creator) bo'lishi va Sozlamalar → Xabarlar → Ulangan vositalar bo'limida \"Xabarlarga ruxsat\" yoqilgan bo'lishi kerak.";
export const TELEGRAM_SWITCH_HINT =
  'Yangi bot uchun @BotFather da Business Mode yoqilishi, so\'ng egasi o\'z telefonida Telegram → Sozlamalar → "Chat Automation" bo\'limida shu botni tanlashi kerak.';

export default function Connections({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<{ connections: Connection[] }>('/api/connections'),
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['connections'] });
    // A bot swap drops the personal accounts the old bot had issued.
    qc.invalidateQueries({ queryKey: ['telegram-personal-accounts'] });
  };

  const instagram = connections.data?.connections?.find((c) => c.channel === 'INSTAGRAM');
  const telegram = connections.data?.connections?.find((c) => c.channel === 'TELEGRAM');

  return (
    <>
      <div className="page-head">
        <IconChip icon={Plug} tone="green" size={42} />
        <div>
          <h1 className="page-title">Ulanishlar</h1>
          <p className="page-sub">
            Holat jonli API orqali tekshiriladi — saqlangan token hali "ulangan" degani emas.
            Avtomatlashtirib bo'lmaydigan qadamlar "Qo'lda bajariladigan ishlar" bo'limida ko'rsatiladi.
          </p>
        </div>
      </div>
      <QueryError error={connections.error} onRetry={() => connections.refetch()} />
      <ChannelAccountCard
        title="Instagram"
        icon={InstagramIcon}
        iconTone="pink"
        channel="instagram"
        connection={instagram}
        isAdmin={isAdmin}
        onChanged={refresh}
        tokenLabel="Instagram access token"
        tokenHint={INSTAGRAM_TOKEN_HINT}
        switchHint={INSTAGRAM_SWITCH_HINT}
      />
      <ChannelAccountCard
        title="Telegram"
        icon={Send}
        iconTone="cyan"
        channel="telegram"
        connection={telegram}
        isAdmin={isAdmin}
        onChanged={refresh}
        tokenLabel="Bot tokeni"
        tokenHint={TELEGRAM_TOKEN_HINT}
        switchHint={TELEGRAM_SWITCH_HINT}
        extraActions={telegram && isAdmin ? <ReconfigureWebhookButton onChanged={refresh} /> : null}
      />
    </>
  );
}

function ReconfigureWebhookButton({ onChanged }: { onChanged: () => void }) {
  const m = useMutation({
    mutationFn: () => api.post('/api/connections/telegram/reconfigure-webhook'),
    onSuccess: onChanged,
  });
  return (
    <button className="small" onClick={() => m.mutate()} disabled={m.isPending}>
      <RefreshCw size={13} className={m.isPending ? 'spin' : ''} />
      {m.isPending ? 'Sozlanmoqda…' : 'Qayta sozlash'}
    </button>
  );
}
