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

type Platform = 'ios-safari' | 'ios-other' | 'android' | 'in-app-android' | 'in-app-ios' | 'desktop';

/** Chrome's documented engagement delay before it offers the prompt. */
const ENGAGEMENT_SECONDS = 30;

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as a Mac; the touch points give it away.
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);

  // Webviews embedded in other apps. Nothing can be installed from one, by
  // anyone — so misreading a webview as a real browser is the worst mistake
  // this function can make: it promises an install that will never arrive.
  //
  // Telegram's in-app browser on Android is the case that matters here, and it
  // names neither itself nor an app. It is an Android WebView, which Google
  // marks with "; wv)" in the platform token — and, since the UA reduction
  // dropped that token on some builds, with "Version/4.0", which Chrome for
  // Android has never sent.
  const namedInApp = /Instagram|FBAN|FBAV|FB_IAB|Line\/|MicroMessenger|BytedanceWebview|TikTok/.test(ua);
  const androidWebview = android && (/;\s*wv\)/.test(ua) || /Version\/\d+\.\d+\s+Chrome/.test(ua));
  const iosWebview = ios && !/Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  if (namedInApp || androidWebview || iosWebview) return ios ? 'in-app-ios' : 'in-app-android';

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

/**
 * Android intent URL that reopens this page in Chrome itself. This is the only
 * reliable escape from an in-app WebView, where nothing can ever be installed.
 * `browser_fallback_url` covers a phone without Chrome.
 */
function chromeIntentUrl(): string {
  const https = window.location.href;
  const bare = https.replace(/^https?:\/\//, '');
  return `intent://${bare}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(https)};end`;
}

/** Platforms where waiting for Chrome's prompt is worth doing at all. */
function canAutoInstall(platform: Platform): boolean {
  return platform === 'android' || platform === 'desktop';
}

interface Step {
  icon: typeof Share;
  text: React.ReactNode;
}

/**
 * A phone with the one control to press marked on it. Words alone kept failing
 * — "the Share button at the bottom" means nothing if you have never noticed
 * it — so the sheet shows where to look.
 */
function PhoneDiagram({ spot }: { spot: 'bottom' | 'top-right' }) {
  const bottom = spot === 'bottom';
  return (
    <svg className="phone-diagram" viewBox="0 0 120 200" role="img" aria-hidden>
      <rect x="10" y="6" width="100" height="188" rx="14" fill="var(--panel)" stroke="var(--border)" strokeWidth="2" />
      <rect x="18" y="22" width="84" height="150" rx="4" fill="#f3f5f8" />
      {/* the page, suggested */}
      <rect x="26" y="36" width="68" height="6" rx="3" fill="#dfe4ec" />
      <rect x="26" y="50" width="52" height="6" rx="3" fill="#e7ebf2" />
      <rect x="26" y="64" width="60" height="6" rx="3" fill="#e7ebf2" />
      {bottom ? (
        <>
          <circle cx="60" cy="180" r="15" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="2" />
          {/* iOS share glyph */}
          <path d="M60 173v11" stroke="var(--accent-dark)" strokeWidth="2" strokeLinecap="round" />
          <path d="M56 177l4-4 4 4" fill="none" stroke="var(--accent-dark)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M54 181v5h12v-5" fill="none" stroke="var(--accent-dark)" strokeWidth="2" strokeLinecap="round" />
          <path d="M60 152v14" stroke="var(--accent)" strokeWidth="2" strokeDasharray="3 3" />
          <path d="M56 162l4 5 4-5" fill="var(--accent)" />
        </>
      ) : (
        <>
          <circle cx="96" cy="16" r="13" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="2" />
          <circle cx="96" cy="11" r="1.8" fill="var(--accent-dark)" />
          <circle cx="96" cy="16" r="1.8" fill="var(--accent-dark)" />
          <circle cx="96" cy="21" r="1.8" fill="var(--accent-dark)" />
          <path d="M96 42V30" stroke="var(--accent)" strokeWidth="2" strokeDasharray="3 3" />
          <path d="M92 34l4-5 4 5" fill="var(--accent)" />
        </>
      )}
    </svg>
  );
}

function stepsFor(platform: Platform): { title: string; intro: string; steps: Step[]; note?: string } {
  switch (platform) {
    case 'ios-safari':
      return {
        title: 'Ikonkani telefon ekraniga qo‘shish',
        intro:
          'App Store kerak emas. Uch qadamdan so‘ng Turon ikonkasi bosh ekranda paydo bo‘ladi va bosganingizda shu sahifa ochiladi.',
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
    case 'in-app-android':
      return {
        title: 'Avval Chrome’da oching',
        intro:
          'Siz Telegram/Instagram ichidagi brauzerdasiz. Bu oynadan ikonka qo‘shib bo‘lmaydi — buni faqat haqiqiy brauzer qila oladi.',
        steps: [
          { icon: Compass, text: <>Pastdagi <strong>“Chrome’da ochish”</strong> tugmasini bosing.</> },
          { icon: MoreVertical, text: <>Yoki shu oynaning menyusidan <strong>“Open in browser”</strong> ni tanlang.</> },
          { icon: Download, text: <>Chrome ochilgach, o‘ng yuqoridagi <strong>“Ilovani o‘rnatish”</strong> tugmasini bosing.</> },
        ],
      };
    case 'in-app-ios':
      return {
        title: 'Avval Safari’da oching',
        intro:
          'Siz Telegram/Instagram ichidagi brauzerdasiz. Bu oynadan ikonka qo‘shib bo‘lmaydi — buni faqat Safari qila oladi.',
        steps: [
          { icon: MoreVertical, text: <>Shu oynaning menyusidan <strong>“Open in Safari”</strong> / <strong>“Safarida ochish”</strong> ni tanlang.</> },
          { icon: Copy, text: <>Agar bunday menyu bo‘lmasa — pastdagi tugma bilan havolani nusxalang va Safari’ga joylashtiring.</> },
          { icon: Share, text: <>Safari’da: <strong>Ulashish</strong> → <strong>“Add to Home Screen”</strong>.</> },
        ],
      };
    case 'android':
      return {
        title: 'Ikonkani telefon ekraniga qo‘shish',
        intro: 'Kutmasdan hoziroq qo‘shmoqchi bo‘lsangiz, Chrome menyusi orqali ham bo‘ladi:',
        steps: [
          { icon: MoreVertical, text: <>Chrome menyusini oching — o‘ng yuqoridagi <strong>⋮</strong>.</> },
          {
            icon: Download,
            text: (
              <>
                <strong>“Install app”</strong> ni tanlang. Agar bunday band bo‘lmasa —{' '}
                <strong>“Add to Home screen”</strong> ni tanlang: u ham ikonkani ekranga qo‘yadi.
              </>
            ),
          },
          { icon: Check, text: <>Tasdiqlang — ikonka bosh ekranda paydo bo‘ladi.</> },
        ],
        note: 'Firefox’da ham: menyu → “Add to Home screen”.',
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

                {(platform === 'ios-safari' || platform === 'android') && (
                  <div className="diagram-row">
                    <PhoneDiagram spot={platform === 'ios-safari' ? 'bottom' : 'top-right'} />
                    <p className="muted">
                      {platform === 'ios-safari'
                        ? 'Ulashish tugmasi ekranning eng pastida, o‘rtada turadi.'
                        : 'Chrome menyusi ekranning eng yuqorisida, o‘ng tomonda.'}
                    </p>
                  </div>
                )}

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

                {platform === 'in-app-android' && (
                  // Android's documented way out of a WebView: an intent URL
                  // naming Chrome, with the plain https address as fallback if
                  // Chrome is absent.
                  <a className="btn primary install-go" href={chromeIntentUrl()}>
                    <Compass size={16} />
                    Chrome’da ochish
                  </a>
                )}
                {(platform === 'in-app-android' || platform === 'in-app-ios') && (
                  <button
                    className={platform === 'in-app-ios' ? 'primary install-go' : 'install-go'}
                    onClick={copyLink}
                  >
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
