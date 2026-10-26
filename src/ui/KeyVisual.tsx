import { keyVisual } from '../../event.config';

/**
 * Build-time constant, written out in full so the bundler can see it: in an
 * `api` (production) build the placeholder below is dead code and is removed.
 * The public must never see a placeholder.
 */
const SHOW_PLACEHOLDER =
  import.meta.env.VITE_STORAGE_ADAPTER !== 'api' && import.meta.env.VITE_STORAGE_ADAPTER !== 'sheet';

/** From this width the optional desktop image is used. Matches the 4-column breakpoint. */
const DESKTOP_QUERY = '(min-width: 900px)';

/**
 * The contest's key visual, at the very top of the voting page.
 *
 * A slot, not an upload feature: the image files are dropped into
 * public/key-visual/ and named in `keyVisual` in event.config.ts.
 *
 * The box has a fixed aspect ratio (16:9, or 3:1 from 900px when a desktop
 * image is set), so the page does not jump while the image arrives. The demo
 * placeholder is 16:9 on phones and 3:1 from 900px, matching the spec sheet. It is the
 * first thing on the page, so it loads eagerly. It is shown as supplied: the
 * contestant-photo treatment is not applied to it.
 *
 * A real image is wrapped in `.kv-band`, which continues the key visual's
 * background colours out to the screen edges (Revision 8).
 */
export function KeyVisualBanner(): JSX.Element | null {
  const { mobile, desktop, alt } = keyVisual;

  if (mobile === null || mobile.trim() === '') {
    if (!SHOW_PLACEHOLDER) return null;
    return (
      <div className="key-visual key-visual--placeholder" role="note">
        <strong>Key visual goes here</strong>
        <span>Phone: 1080 × 608 px (16:9) · Desktop: 1920 × 640 px (3:1)</span>
        <span>JPG or WebP, under 250 KB · demo only</span>
      </div>
    );
  }

  const hasDesktop = desktop !== undefined && desktop !== null && desktop.trim() !== '';
  // The band carries the page background behind and beside the banner, matched
  // to the key visual's own colours (see "key visual band" in app.css).
  return (
    <div className={`kv-band${hasDesktop ? ' kv-band--desktop' : ''}`}>
      <div className={`key-visual${hasDesktop ? ' key-visual--has-desktop' : ''}`}>
        <picture>
          {hasDesktop && <source media={DESKTOP_QUERY} srcSet={desktop} />}
          <img
            className="key-visual__img"
            src={mobile}
            alt={alt}
            width={1080}
            height={608}
            loading="eager"
            decoding="async"
          />
        </picture>
      </div>
    </div>
  );
}
