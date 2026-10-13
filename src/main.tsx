import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// Poppins, YouTrip's brand font (Revision 6), self-hosted (SIL Open Font
// License) and bundled with the page: no request to Google or any other font
// service. Latin subset, only the four weights used: 400, 500, 700, 800.
import '@fontsource/poppins/latin-400.css';
import '@fontsource/poppins/latin-500.css';
import '@fontsource/poppins/latin-700.css';
import '@fontsource/poppins/latin-800.css';
import './styles/app.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Missing #root element');

/**
 * A static host such as GitHub Pages cannot send the headers that stop a page
 * being embedded in someone else's. Embedded, the voting page could be dressed
 * up so that a visitor's taps cast a vote they did not mean to. So the page
 * checks for itself, and refuses to show anything tappable inside a frame.
 */
function isFramed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    // Reading window.top across origins throws. That is a frame too.
    return true;
  }
}

if (isFramed()) {
  const link = document.createElement('a');
  link.href = window.location.href;
  link.target = '_top';
  link.rel = 'noopener';
  link.textContent = 'Open the voting page';
  link.style.cssText = 'display:block;padding:24px;font:500 18px Poppins,system-ui,sans-serif;color:#b794ff';
  root.replaceChildren(link);
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
