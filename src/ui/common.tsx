import { useEffect, useRef, type ReactNode } from 'react';
import { event } from '../../event.config';
import type { VotingStatus } from '../domain/types';

/** Set only by `npm run deploy:test`: a demo build published for testing on real phones. */
const TEST_DEPLOY = import.meta.env.VITE_TEST_DEPLOY === '1';

export function DemoBanner(): JSX.Element {
  if (TEST_DEPLOY) {
    return (
      <div className="demo-banner" role="note">
        <strong>TEST SITE</strong>
        <span>Votes are not real.</span>
      </div>
    );
  }
  return (
    <div className="demo-banner" role="note">
      <strong>DEMO DATA</strong>
      <span>Votes are stored in this browser only. Nothing here is a real result.</span>
    </div>
  );
}

const STATUS_LABEL: Record<VotingStatus, string> = {
  not_open: 'Voting not open yet',
  open: 'Voting open',
  closed: 'Voting closed',
};

export function StatusPill({ status }: { status: VotingStatus }): JSX.Element {
  return (
    <span className={`pill pill--${status}`}>
      <span className="pill__dot" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Brand(): JSX.Element {
  return (
    <p className="brand">
      <span className="brand__mark">{event.organiser}</span>
      <span className="brand__sep" aria-hidden="true">
        /
      </span>
      <span>{event.title}</span>
    </p>
  );
}

export function Spinner({ label }: { label: string }): JSX.Element {
  return (
    <div className="spinner" role="status">
      <span className="spinner__ring" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

interface MessageProps {
  tone?: 'neutral' | 'warn' | 'good';
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}

export function Message({ tone = 'neutral', title, children, action }: MessageProps): JSX.Element {
  return (
    <section className={`message message--${tone}`}>
      <h2>{title}</h2>
      {children !== undefined && <div className="message__body">{children}</div>}
      {action !== undefined && <div className="message__action">{action}</div>}
    </section>
  );
}

interface SheetProps {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  children: ReactNode;
}

/**
 * Keeps two CSS variables in step with the part of the screen that is actually
 * visible: --vv-top and --vv-height.
 *
 * On a phone, the on-screen keyboard covers the bottom of the page without the
 * page being told its size has changed. Anything pinned to the bottom of the
 * screen ends up underneath the keyboard. The browser does report the visible
 * area separately (the "visual viewport"), so the sheet is laid out inside
 * that instead, and sits just above the keyboard with its button in reach.
 */
const SHORT_VIEWPORT_PX = 520;

function useVisibleArea(active: boolean): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    if (!active || viewport === null || viewport === undefined) return undefined;

    const apply = (): void => {
      root.style.setProperty('--vv-top', `${Math.max(0, viewport.offsetTop)}px`);
      root.style.setProperty('--vv-height', `${viewport.height}px`);
      // Keyboard up on a small phone: the stylesheet drops the sheet's picture.
      root.toggleAttribute('data-vv-short', viewport.height < SHORT_VIEWPORT_PX);
    };
    apply();
    viewport.addEventListener('resize', apply);
    viewport.addEventListener('scroll', apply);
    return () => {
      viewport.removeEventListener('resize', apply);
      viewport.removeEventListener('scroll', apply);
      root.style.removeProperty('--vv-top');
      root.style.removeProperty('--vv-height');
      root.removeAttribute('data-vv-short');
    };
  }, [active]);
}

/**
 * Modal sheet on the native <dialog>: focus trap, Escape and backdrop come for free.
 * Docked to the bottom of the visible screen on a phone, where a thumb reaches;
 * a centred dialog on anything wider.
 *
 * In-app browsers run on whatever web engine the phone's OS ships, and <dialog>
 * only reached iOS in 15.4. Where showModal is missing the sheet falls back to
 * the `open` attribute plus a CSS class that draws the backdrop itself.
 */
export function Sheet({ open, onClose, labelledBy, children }: SheetProps): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  useVisibleArea(open);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    const native = typeof dialog.showModal === 'function';
    if (open && !dialog.open) {
      if (native) dialog.showModal();
      else {
        dialog.setAttribute('open', '');
        dialog.classList.add('sheet--fallback');
      }
    }
    if (!open && dialog.open) {
      if (native) dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby={labelledBy}
      onClose={onClose}
      onCancel={onClose}
      onClick={(clickEvent) => {
        // A click outside the sheet's body lands on the dialog element itself.
        if (clickEvent.target === ref.current) onClose();
      }}
    >
      <div className="sheet__body">{children}</div>
    </dialog>
  );
}
