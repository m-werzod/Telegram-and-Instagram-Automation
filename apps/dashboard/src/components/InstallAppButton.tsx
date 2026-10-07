import { useEffect, useState } from 'react';
import { Download, Share, PlusSquare, X, MoreVertical } from 'lucide-react';

/**
 * "Install as an app" — the button that puts this on a phone's home screen.
 *
 * Two completely different mechanics behind one control:
 *
 *  - Chrome/Edge/Samsung (Android, desktop) fire `beforeinstallprompt`, which
 *    can be saved and replayed from a click. That gives a real one-tap install.
 *  - iOS Safari has no such event and never will; Add to Home Screen is a
 *    manual gesture in the share sheet. So on iOS the button opens the exact
 *    steps instead of pretending a prompt exists.
 *
 * When neither applies — already installed, or a browser that cannot install —
 * the button renders nothing rather than offering something that won't work.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as a Mac; the touch points give it away.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // Safari's own non-standard flag — the only signal iOS gives.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export default function InstallAppButton({ variant = 'login' }: { variant?: 'login' | 'inline' }) {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone());
  const [showIosSteps, setShowIosSteps] = useState(false);
  const ios = isIos();

  useEffect(() => {
    const onPrompt = (e: Event) => {
      // Chrome shows its own mini-infobar unless the event is cancelled; we
      // want the install to happen from our button, where it is explained.
      e.preventDefault();
      setPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPrompt(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // Already running as an app, or a browser that offers no way in.
  if (installed || (!prompt && !ios)) return null;

  const install = async () => {
    if (ios && !prompt) {
      setShowIosSteps(true);
      return;
    }
    if (!prompt) return;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    // A dismissed prompt cannot be replayed — Chrome fires a fresh event when
    // it decides the user is ready again.
    if (outcome === 'accepted') setInstalled(true);
    setPrompt(null);
  };

  return (
    <>
      <button
        type="button"
        className={variant === 'login' ? 'install-btn' : 'small'}
        onClick={install}
      >
        <Download size={variant === 'login' ? 15 : 13} strokeWidth={2} />
        Ilova sifatida o'rnatish
      </button>

      {showIosSteps && (
        <div
          className="sheet-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Ilovani o'rnatish"
          onClick={() => setShowIosSteps(false)}
        >
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="row between">
              <h3 style={{ margin: 0 }}>Telefonga o'rnatish</h3>
              <button
                className="icon-only"
                onClick={() => setShowIosSteps(false)}
                aria-label="Yopish"
              >
                <X size={18} />
              </button>
            </div>
            <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
              iPhone va iPad'da bu uch qadam bilan bajariladi — App Store kerak emas.
            </p>
            {/* Each step's sentence lives in ONE span: the <li> is a flex row,
                and bare text around a <strong> would become separate flex
                items, laying the sentence out as columns. */}
            <ol className="install-steps">
              <li>
                <span className="step-icon">
                  <Share size={16} />
                </span>
                <span>
                  Safari'ning pastidagi <strong>Ulashish</strong> tugmasini bosing.
                </span>
              </li>
              <li>
                <span className="step-icon">
                  <PlusSquare size={16} />
                </span>
                <span>
                  Ro'yxatdan <strong>“Add to Home Screen”</strong> (Bosh ekranga qo'shish) ni
                  tanlang.
                </span>
              </li>
              <li>
                <span className="step-icon">
                  <PlusSquare size={16} />
                </span>
                <span>
                  O'ng yuqoridagi <strong>“Add”</strong> ni bosing — ilova bosh ekranda paydo
                  bo'ladi.
                </span>
              </li>
            </ol>
            <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
              Android'da: brauzer menyusi{' '}
              <MoreVertical size={13} style={{ display: 'inline', verticalAlign: -2 }} /> →{' '}
              <strong>“Install app”</strong> / <strong>“Ilovani o'rnatish”</strong>.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
