import { useEffect, useRef, useState } from 'react';
import {
  Download,
  Share,
  PlusSquare,
  X,
  MoreVertical,
  Copy,
  Check,
  Compass,
  Loader2,
} from 'lucide-react';

/**
 * "Install the app" — one button, same corner, every device.
 *
 * The thing that makes this harder than it looks: Chrome does NOT hand over
 * the install prompt immediately. Its documented engagement heuristic needs the
 * user to have tapped the page AND to have been on it for ~30 seconds before
 * `beforeinstallprompt` fires. An earlier version of this component asked once,
 * at click time, found nothing, and showed manual instructions forever — so on
 * a perfectly installable Android phone the one-tap install never appeared,
 * which is exactly what it looked like from the outside: "the button is there
 * but it doesn't install".
 *
 * So the event is never given up on. The listener stays mounted, and if the
 * prompt arrives while the sheet is open the sheet turns into a real install
 * button in place. The waiting is shown rather than hidden, because a visible
 * "ready in a few seconds" is a working flow and a silent wait is a dead end.
 *
 * iOS is the genuine exception: Apple ships no install API and no equivalent
 * event, so Add to Home Screen stays a manual gesture there. The sheet gives
 * the exact taps instead of pretending something was installed.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type Platform = 'ios-safari' | 'ios-other' | 'android' | 'in-app' | 'desktop';

/** Chrome's documented engagement delay before it offers the prompt. */
const ENGAGEMENT_SECONDS = 30;

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as a Mac; the touch points give it away.
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);

  // Webviews embedded in other apps. Named ones first; then iOS WKWebView,
  // which is recognisable because a real iOS browser always carries one of
  // these tokens and an embedded one usually carries none.
  const namedInApp = /Instagram|FBAN|FBAV|FB_IAB|Line\/|MicroMessenger|BytedanceWebview|TikTok/.test(ua);
  const iosWebview = ios && !/Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  if (namedInApp || iosWebview) return 'in-app';

  if (ios) return /CriOS|FxiOS|EdgiOS/.test(ua) ? 'ios-other' : 'ios-safari';
  if (android) return 'android';
  return 'desktop';
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // Safari's own non-standard flag — the only signal iOS gives.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** Platforms where waiting for Chrome's prompt is worth doing at all. */
function canAutoInstall(platform: Platform): boolean {
  return platform === 'android' || platform === 'desktop';
}

interface Step {
  icon: typeof Share;
  text: React.ReactNode;
}

function stepsFor(platform: Platform): { title: string; intro: string; steps: Step[]; note?: string } {
  switch (platform) {
    case 'ios-safari':
      return {
        title: 'iPhone / iPad ga o‘rnatish',
        intro: 'App Store kerak emas. Uch qadam — keyin ilova bosh ekranda turadi.',
        steps: [
          {
            icon: Share,
            text: (
              <>
                Ekranning <strong>pastidagi</strong> <strong>Ulashish</strong> tugmasini bosing —
                to‘rtburchakdan yuqoriga chiqayotgan strelka.
              </>
            ),
          },
          { icon: PlusSquare, text: <>Ro‘yxatni pastga suring va <strong>“Add to Home Screen”</strong> (Bosh ekranga qo‘shish) ni tanlang.</> },
          { icon: Check, text: <>O‘ng yuqoridagi <strong>“Add”</strong> ni bosing. Tamom.</> },
        ],
        note: 'Apple veb-sahifaga o‘zi o‘rnatishga ruxsat bermaydi — iPhone’da faqat shu yo‘l bor. Android’da esa bir bosishda o‘rnatiladi.',
      };
    case 'ios-other':
      return {
        title: 'iPhone / iPad ga o‘rnatish',
        intro: 'Siz Safari’da emassiz. iPhone’da o‘rnatish faqat Safari orqali ishlaydi.',
        steps: [
          { icon: Compass, text: <>Brauzer menyusidan <strong>“Open in Safari”</strong> ni tanlang.</> },
          { icon: Share, text: <>Safari’da pastdagi <strong>Ulashish</strong> tugmasini bosing.</> },
          { icon: PlusSquare, text: <><strong>“Add to Home Screen”</strong> → <strong>“Add”</strong>.</> },
        ],
        note: 'Apple veb-sahifaga o‘zi o‘rnatishga ruxsat bermaydi — iPhone’da faqat shu yo‘l bor.',
      };
    case 'in-app':
      return {
        title: 'Avval oddiy brauzerda oching',
        intro: 'Siz Telegram/Instagram ichidagi brauzerdasiz — bu yerdan hech qanday ilova o‘rnatilmaydi.',
        steps: [
          { icon: MoreVertical, text: <>Shu oynaning menyusidan <strong>“Open in browser”</strong> / <strong>“Brauzerda ochish”</strong> ni tanlang.</> },
          { icon: Copy, text: <>Yoki pastdagi tugma bilan havolani nusxalab, Safari (iPhone) yoki Chrome (Android) ga joylashtiring.</> },
          { icon: Download, text: <>So‘ng shu tugmani yana bosing.</> },
        ],
      };
    case 'android':
      return {
        title: 'Android ga o‘rnatish',
        intro: 'Kutmasdan hoziroq o‘rnatmoqchi bo‘lsangiz, menyudan qo‘lda qo‘shsa ham bo‘ladi:',
        steps: [
          { icon: MoreVertical, text: <>Chrome menyusini oching — o‘ng yuqoridagi <strong>⋮</strong>.</> },
          { icon: Download, text: <><strong>“Install app”</strong> / <strong>“Ilovani o‘rnatish”</strong> ni tanlang.</> },
          { icon: Check, text: <><strong>“Install”</strong> ni tasdiqlang.</> },
        ],
        note: 'Firefox’da: menyu → “Add to Home screen”.',
      };
    default:
      return {
        title: 'Kompyuterga o‘rnatish',
        intro: 'Kutmasdan o‘rnatmoqchi bo‘lsangiz, manzil qatoridan ham bo‘ladi:',
        steps: [
          { icon: Download, text: <>Manzil qatorining o‘ng chekkasidagi <strong>o‘rnatish</strong> belgisini (monitor + strelka) bosing.</> },
          { icon: MoreVertical, text: <>Yoki menyu <strong>⋮</strong> → <strong>“Install Turon AI Platforma”</strong>.</> },
          { icon: Check, text: <><strong>“Install”</strong> ni tasdiqlang.</> },
        ],
        note: 'Safari (Mac) da: File → Add to Dock.',
      };
  }
}

export default function InstallAppButton({
  variant = 'corner',
}: {
  variant?: 'corner' | 'topbar' | 'inline';
}) {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone());
  const [sheet, setSheet] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  /** Seconds this page has been open — Chrome needs ~30 before it offers. */
  const [elapsed, setElapsed] = useState(0);
  const mountedAt = useRef(Date.now());
  const platform = detectPlatform();
  const waitable = canAutoInstall(platform);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      // Chrome shows its own mini-infobar unless the event is cancelled; the
      // install belongs on this button, where it is explained.
      e.preventDefault();
      setPrompt(e as BeforeInstallPromptEvent);
      setDismissed(false);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPrompt(null);
      setSheet(false);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // Drives the "ready in N seconds" line. Only ticks while the sheet is open
  // and the prompt has not arrived, so it costs nothing the rest of the time.
  useEffect(() => {
    if (!sheet || prompt || !waitable) return;
    const t = setInterval(
      () => setElapsed(Math.floor((Date.now() - mountedAt.current) / 1000)),
      1000,
    );
    return () => clearInterval(t);
  }, [sheet, prompt, waitable]);

  // The one case where the button has nothing to offer.
  if (installed) return null;

  const fire = async (saved: BeforeInstallPromptEvent) => {
    setBusy(true);
    try {
      await saved.prompt();
      const { outcome } = await saved.userChoice;
      if (outcome === 'accepted') {
        setInstalled(true); // `appinstalled` also fires, but not on every build
        setSheet(false);
      } else {
        // A used prompt cannot be replayed. Chrome fires a fresh one later.
        setPrompt(null);
        setDismissed(true);
      }
    } catch {
      setPrompt(null);
    } finally {
      setBusy(false);
    }
  };

  const click = () => {
    // Ready right now: straight to the system dialog, no sheet at all.
    if (prompt) return void fire(prompt);
    setElapsed(Math.floor((Date.now() - mountedAt.current) / 1000));
    setSheet(true);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.origin);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };

  const guide = stepsFor(platform);
  const label = "Ilovani o'rnatish";
  const remaining = Math.max(0, ENGAGEMENT_SECONDS - elapsed);

  return (
    <>
      <button
        type="button"
        className={
          variant === 'corner' ? 'install-corner' : variant === 'topbar' ? 'install-topbar' : 'small'
        }
        onClick={click}
        disabled={busy}
        title={label}
        aria-label={label}
      >
        <Download size={variant === 'topbar' ? 18 : 15} strokeWidth={2.2} />
        <span className="install-label">{label}</span>
      </button>

      {sheet && (
        <div
          className="sheet-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={label}
          onClick={() => setSheet(false)}
        >
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="row between">
              <h3 style={{ margin: 0 }}>{prompt ? 'O‘rnatishga tayyor' : guide.title}</h3>
              <button className="icon-only" onClick={() => setSheet(false)} aria-label="Yopish">
                <X size={18} />
              </button>
            </div>

            {/* The prompt arrived while this sheet was open — the whole point of
                not giving up. One press and the phone's own dialog appears. */}
            {prompt ? (
              <>
                <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                  Brauzer tayyor. Quyidagi tugmani bosing va telefoningiz so‘raganda{' '}
                  <strong>“O‘rnatish / Install”</strong> ni tasdiqlang.
                </p>
                <button
                  className="primary install-go"
                  disabled={busy}
                  onClick={() => fire(prompt)}
                >
                  <Download size={17} />
                  {busy ? 'Ochilmoqda…' : 'Hozir o‘rnatish'}
                </button>
                <p className="muted" style={{ fontSize: 12.5, margin: '12px 0 0' }}>
                  O‘rnatilgach ilova bosh ekranda <strong>Turon</strong> belgisi va{' '}
                  <strong>“Turon AI”</strong> yozuvi bilan turadi.
                </p>
              </>
            ) : (
              <>
                {waitable && (
                  <div className="install-waiting">
                    <Loader2 size={18} className="spin" />
                    <div>
                      <strong>
                        {dismissed
                          ? 'Bekor qilindi — qayta tayyorlanmoqda'
                          : 'Avtomatik o‘rnatish tayyorlanmoqda…'}
                      </strong>
                      <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
                        {remaining > 0
                          ? `Chrome sahifada ~${ENGAGEMENT_SECONDS} soniya bo‘lishingizni kutadi. Taxminan ${remaining} soniya qoldi — shu oynani ochiq qoldiring, tugma o‘zi shu yerda paydo bo‘ladi.`
                          : 'Deyarli tayyor. Shu oynani ochiq qoldiring — tugma shu yerda paydo bo‘ladi.'}
                      </div>
                    </div>
                  </div>
                )}

                <p className="muted" style={{ fontSize: 13, marginTop: waitable ? 14 : 6 }}>
                  {guide.intro}
                </p>

                {/* Each step's sentence lives in ONE span: the <li> is a flex
                    row, and bare text around a <strong> would become separate
                    flex items, laying the sentence out as columns. */}
                <ol className="install-steps">
                  {guide.steps.map((s, i) => (
                    <li key={i}>
                      <span className="step-icon">
                        <s.icon size={16} />
                      </span>
                      <span>{s.text}</span>
                    </li>
                  ))}
                </ol>

                {platform === 'in-app' && (
                  <button className="primary install-go" onClick={copyLink}>
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                    {copied ? 'Nusxalandi — brauzerga joylashtiring' : 'Havolani nusxalash'}
                  </button>
                )}

                {guide.note && (
                  <p className="muted" style={{ fontSize: 12.5, margin: '12px 0 0' }}>
                    {guide.note}
                  </p>
                )}
              </>
            )}

            {/* Makes a failure reportable instead of "it doesn't work". */}
            <details className="install-diag">
              <summary>Texnik holat</summary>
              <div className="mono">
                brauzer: {platform}
                <br />
                xavfsiz ulanish: {window.isSecureContext ? 'ha' : "yo'q"}
                <br />
                avtomatik o‘rnatish: {prompt ? 'tayyor' : waitable ? 'kutilmoqda' : 'qo‘llanmaydi'}
                <br />
                sahifada: {elapsed}s
              </div>
            </details>
          </div>
        </div>
      )}
    </>
  );
}
