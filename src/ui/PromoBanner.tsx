import { promoBanner } from '../../event.config';

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
  /** Where it sits on the page, for layout and tests: after the vote message, or at the bottom. */
  placement: 'after-vote' | 'bottom';
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
export function PromoBannerSlot({ placement }: Props): JSX.Element | null {
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
        loading="lazy"
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
