import { useEffect, useState } from 'react';

export type Route = { view: 'vote' } | { view: 'admin' };

/**
 * Hash routing: works on any static host with no rewrite rules.
 *
 *   /           the public voting page. This is the link that goes on Instagram.
 *   /#/admin    the admin view
 *
 * The voting page is the default for everything else, including whatever
 * tracking parameters a link picks up on its way through Instagram (?fbclid=...,
 * ?igsh=...). A voter must never land on an error because of how they arrived.
 */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').replace(/\/+$/, '');
  const [head = ''] = path.split(/[/?]/);
  return head === 'admin' ? { view: 'admin' } : { view: 'vote' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = (): void => {
      setRoute(parseRoute(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
