import { useEffect } from 'react';
import { promoBanner } from '../../event.config';
import { Sheet } from './common';

/** Below this width the optional phone image is used. */
const PHONE_QUERY = '(max-width: 639px)';

/** Only a plain https:// address becomes a link: never javascript:, data: or a relative path. */
function safeHref(href: string | undefined): string | null {
  if (href === undefined) return null;
  const trimmed = href.trim();
  if (!/^https:\/\/[^\s]+$/i.test(trimmed)) return null;
  try {
    return new URL(trimmed).protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
}

interface Props {
  /** Where it sits, for layout and tests: at the bottom of the page, or in the post-vote pop-up. */
  placement: 'bottom' | 'pop-up';
  /** Lazy below the fold; eager in the pop-up, which is on screen the moment it opens. */
  eager?: boolean;
}

export function hasPromoBanner(): boolean {
  return promoBanner.image !== null && promoBanner.image.trim() !== '';
}

/**
 * The campaign promo banner (Revision 7): an image and, optionally, a link.
 * No caption and no other text. Renders nothing when no image is configured,
 * in the demo and production alike.
 *
 * Fixed aspect ratio (3:1, or 16:9 below 640px when a phone image is set) so
 * nothing jumps as it loads, and lazy-loaded: it starts below the fold. It is
 * shown as supplied; the contestant-photo treatment is not applied.
 */
export function PromoBannerSlot({ placement, eager = false }: Props): JSX.Element | null {
  const { image, phoneImage, alt, href } = promoBanner;
  if (image === null || image.trim() === '') return null;

  const hasPhone = typeof phoneImage === 'string' && phoneImage.trim() !== '';
  const link = safeHref(href);
  const className = `promo-banner${hasPhone ? ' promo-banner--has-phone' : ''}`;
  const picture = (
    <picture>
      {hasPhone && <source media={PHONE_QUERY} srcSet={phoneImage} />}
      <img
        className="promo-banner__img"
        src={image}
        alt={alt}
        width={1920}
        height={640}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
      />
    </picture>
  );

  return link === null ? (
    <div className={className} data-placement={placement}>
      {picture}
    </div>
  ) : (
    <a className={className} data-placement={placement} href={link} target="_blank" rel="noopener noreferrer">
      {picture}
    </a>
  );
}

/**
 * Revision 10: the promo as a pop-up straight after a vote is counted. An image
 * (a link once promoBanner.href is set) and a Close button. Nothing else.
 *
 * Opening it adds a browser history entry, so the phone's Back gesture closes
 * the pop-up and leaves the visitor on the voting page with every contestant,
 * instead of taking them out of the site.
 */
export function PromoPopup({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  useEffect(() => {
    if (!open) return undefined;
    window.history.pushState({ imc4PromoPopup: true }, '');
    const onBack = (): void => onClose();
    window.addEventListener('popstate', onBack);
    return () => window.removeEventListener('popstate', onBack);
  }, [open, onClose]);

  // Not in the page at all while closed: only one dialog.sheet exists at a time.
  if (!open || !hasPromoBanner()) return null;

  const close = (): void => {
    // Closed with the button or the backdrop: take back the history entry it added.
    if ((window.history.state as { imc4PromoPopup?: boolean } | null)?.imc4PromoPopup === true) {
      window.history.back();
    } else {
      onClose();
    }
  };

  return (
    <Sheet open onClose={close} label={promoBanner.alt} className="sheet--promo">
      <PromoBannerSlot placement="pop-up" eager />
      <div className="sheet__actions">
        <button type="button" className="button button--ghost button--wide" onClick={close}>
          Close
        </button>
      </div>
    </Sheet>
  );
}
