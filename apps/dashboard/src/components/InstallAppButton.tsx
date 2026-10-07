import { useEffect, useState } from 'react';
import { Download, Share, PlusSquare, X, MoreVertical, Copy, Check, Compass } from 'lucide-react';

/**
 * "Install the app" — one button, always in the same corner, on every device.
 *
 * It cannot be one mechanism, because the platforms do not agree:
 *
 *  - Chrome/Edge/Samsung fire `beforeinstallprompt`, which can be saved and
 *    replayed from a click. One tap, a real install dialog, done.
 *  - iOS has NO equivalent and Apple provides none. Add to Home Screen is a
 *    manual gesture in Safari's share sheet that no page can trigger. So the
 *    button opens the exact steps instead of pretending it installed something.
 *  - In-app browsers (a link opened inside Telegram, Instagram, Facebook)
 *    cannot install at all, by anyone. The only way forward is to reopen the
 *    link in a real browser, so that is what the button offers there —
 *    including copying the address, since those webviews often hide it.
 *
 * What changed from the first version: it used to render nothing whenever no
 * install event had fired, so on perfectly capable browsers there was simply no
 * button. Now the only case that hides it is already being installed, where it
 * would be meaningless.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type Platform = 'ios-safari' | 'ios-other' | 'android' | 'in-app' | 'desktop';

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

interface Step {
  icon: typeof Share;
  text: React.ReactNode;
}

function stepsFor(platform: Platform): { title: string; intro: string; steps: Step[]; note?: string } {
  switch (platform) {
    case 'ios-safari':
      return {
        title: 'iPhone / iPad ga o‘rnatish',
        intro: 'App Store kerak emas — uch qadam, keyin ilova bosh ekranda turadi.',
        steps: [
          { icon: Share, text: <>Pastdagi <strong>Ulashish</strong> tugmasini bosing (yuqoriga qaragan strelka).</> },
          { icon: PlusSquare, text: <>Ro‘yxatni pastga suring va <strong>“Add to Home Screen”</strong> ni tanlang.</> },
          { icon: Check, text: <>O‘ng yuqoridagi <strong>“Add”</strong> ni bosing.</> },
        ],
        note: 'Apple sahifaga o‘zi o‘rnatishga ruxsat bermaydi — iPhone’da bu qadamlar yagona yo‘l.',
      };
    case 'ios-other':
      return {
        title: 'iPhone / iPad ga o‘rnatish',
        intro: 'Eng ishonchli yo‘l — shu sahifani Safari’da ochish.',
        steps: [
          { icon: Compass, text: <>Brauzer menyusidan <strong>“Open in Safari”</strong> ni tanlang (yoki havolani Safari’ga nusxalang).</> },
          { icon: Share, text: <>Safari’da pastdagi <strong>Ulashish</strong> tugmasini bosing.</> },
          { icon: PlusSquare, text: <><strong>“Add to Home Screen”</strong> → <strong>“Add”</strong>.</> },
        ],
        note: 'Apple sahifaga o‘zi o‘rnatishga ruxsat bermaydi — iPhone’da bu qadamlar yagona yo‘l.',
      };
    case 'in-app':
      return {
        title: 'Avval oddiy brauzerda oching',
        intro:
          'Siz hozir Telegram/Instagram ichidagi brauzerdasiz — bu yerdan hech qanday ilova o‘rnatilmaydi.',
        steps: [
          { icon: MoreVertical, text: <>Shu oynaning menyusidan <strong>“Open in browser”</strong> / <strong>“Brauzerda ochish”</strong> ni tanlang.</> },
          { icon: Copy, text: <>Yoki pastdagi tugma bilan havolani nusxalab, Safari (iPhone) yoki Chrome (Android) ga joylashtiring.</> },
          { icon: Download, text: <>So‘ng shu tugmani yana bosing — o‘rnatish taklifi chiqadi.</> },
        ],
      };
    case 'android':
      return {
        title: 'Android ga o‘rnatish',
        intro: 'Agar o‘rnatish oynasi o‘zi chiqmagan bo‘lsa, menyudan qo‘lda qo‘shing.',
        steps: [
          { icon: MoreVertical, text: <>Chrome menyusini oching (o‘ng yuqoridagi <strong>⋮</strong>).</> },
          { icon: Download, text: <><strong>“Install app”</strong> yoki <strong>“Ilovani o‘rnatish”</strong> ni tanlang.</> },
          { icon: Check, text: <><strong>“Install”</strong> ni tasdiqlang.</> },
        ],
        note: 'Chrome’da ochilgan bo‘lsa odatda bir bosishda o‘rnatiladi. Firefox’da: menyu → “Add to Home screen”.',
      };
    default:
      return {
        title: 'Kompyuterga o‘rnatish',
        intro: 'Chrome yoki Edge’da manzil qatorining o‘ng chekkasidagi o‘rnatish belgisini bosing.',
        steps: [
          { icon: Download, text: <>Manzil qatorida <strong>o‘rnatish</strong> belgisini (monitor + strelka) bosing.</> },
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
  const platform = detectPlatform();

  useEffect(() => {
    const onPrompt = (e: Event) => {
      // Chrome shows its own mini-infobar unless the event is cancelled; the
      // install should happen from this button, where it is explained.
      e.preventDefault();
      setPrompt(e as BeforeInstallPromptEvent);
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

  // The one case where the button has nothing to offer.
  if (installed) return null;

  const click = async () => {
    if (prompt) {
      // The real thing: a one-tap system install dialog.
      await prompt.prompt();
      const { outcome } = await prompt.userChoice;
      if (outcome === 'accepted') setInstalled(true);
      // A dismissed prompt cannot be replayed; Chrome fires a fresh event when
      // it decides the user is ready again. Fall back to the steps meanwhile.
      setPrompt(null);
      return;
    }
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

  return (
    <>
      <button
        type="button"
        className={
          variant === 'corner' ? 'install-corner' : variant === 'topbar' ? 'install-topbar' : 'small'
        }
        onClick={click}
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
              <h3 style={{ margin: 0 }}>{guide.title}</h3>
              <button className="icon-only" onClick={() => setSheet(false)} aria-label="Yopish">
                <X size={18} />
              </button>
            </div>
            <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
              {guide.intro}
            </p>

            {/* Each step's sentence lives in ONE span: the <li> is a flex row,
                and bare text around a <strong> would become separate flex
                items, laying the sentence out as columns. */}
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
              <button className="primary" style={{ width: '100%', justifyContent: 'center' }} onClick={copyLink}>
                {copied ? <Check size={15} /> : <Copy size={15} />}
                {copied ? 'Nusxalandi — endi brauzerga joylashtiring' : 'Havolani nusxalash'}
              </button>
            )}

            {guide.note && (
              <p className="muted" style={{ fontSize: 12.5, margin: '12px 0 0' }}>
                {guide.note}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
