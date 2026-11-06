import { useId } from 'react';
import { promoBanner, promoDetails } from '../../event.config';
import { Sheet, useBackClosesSheet } from './common';

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
  /**
   * Where it sits, for layout and tests: at the bottom of the page, in the
   * post-vote panel, or under the "You voted for" line (Revision 12).
   */
  placement: 'bottom' | 'pop-up' | 'lede';
  /** Lazy below the fold; eager in the panel and under the lede, which are on screen at once. */
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

/** The panel heading, with the contestant's name when it is known. */
export function voteIsInHeading(name: string | undefined): string {
  return name === undefined || name.trim() === ''
    ? promoDetails.heading
    : promoDetails.headingWithName.replace('{name}', name);
}

/**
 * Revision 11: the "Your vote is in" panel, straight after a vote is counted.
 * Heading, the promo image, the promo's short lines, a button to the promo
 * link (when one is set) and Close. Replaces Revision 10's image-only pop-up.
 *
 * Opening it adds a browser history entry, so the phone's Back gesture closes
 * the panel and leaves the visitor on the voting page with every contestant,
 * instead of taking them out of the site.
 */
export function PromoPopup({
  open,
  onClose,
  votedForName,
}: {
  open: boolean;
  onClose: () => void;
  /** e.g. "#7 Jun Hao". Omitted: the heading has no name. */
  votedForName?: string;
}): JSX.Element | null {
  const headingId = useId();
  const close = useBackClosesSheet(open, onClose, 'imc4PromoPopup');

  // Not in the page at all while closed: only one dialog.sheet exists at a time.
  if (!open || !hasPromoBanner()) return null;
  const link = safeHref(promoBanner.href);

  return (
    <Sheet open onClose={close} labelledBy={headingId} className="sheet--promo">
      <h2 id={headingId}>{voteIsInHeading(votedForName)}</h2>
      <PromoBannerSlot placement="pop-up" eager />
      <ul className="promo-details">
        {promoDetails.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div className="sheet__actions">
        {link !== null && (
          <a className="button button--wide" href={link} target="_blank" rel="noopener noreferrer">
            {promoDetails.cta}
          </a>
        )}
        <button type="button" className="button button--ghost button--wide" onClick={close}>
          Close
        </button>
      </div>
    </Sheet>
  );
}
