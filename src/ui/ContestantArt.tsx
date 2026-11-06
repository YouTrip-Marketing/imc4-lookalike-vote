import type { Contestant } from '../domain/types';

interface Props {
  contestant: Contestant;
  /** Hide the "photo to come" caption where the tile is too small to read it. */
  compact?: boolean;
}

/**
 * Contestant image slot, 4:5 portrait.
 *
 * Revision 13c (Kelicia, 6 Nov 2026): photos are shown as supplied, full colour,
 * cover-cropped to 4:5. Only the placeholder tiles keep the purple Spotlight
 * Arena treatment (CSS, `.card__art`, `.sheet__art`; photo wrappers carry the
 * `--photo` modifier, which switches it off).
 *
 * With no photo configured this draws an abstract stage: a spotlight beam,
 * haze and a floor pool, in greys, varied per contestant so the grid does not
 * look copy-pasted. It is deliberately not a face, a silhouette or a likeness
 * of anyone. Real photos appear only once a consented file is set in the config.
 */
export function ContestantArt({ contestant, compact = false }: Props): JSX.Element {
  if (contestant.photo !== null) {
    return (
      <img
        className="art art--photo"
        src={contestant.photo}
        // Revision 13d: the contestant's name only.
        alt={contestant.stageName}
        // 4:5 portrait tiles, two to a row on a phone. Declaring the size up front
        // stops the grid jumping as photos arrive over a slow connection.
        width={480}
        height={600}
        loading="lazy"
        decoding="async"
      />
    );
  }

  // Deterministic variety from the contestant number: where the beam comes
  // from, how wide it is, how bright the haze is.
  const n = contestant.number;
  const beamX = 40 + ((n * 37) % 80);
  const beamWidth = 34 + ((n * 13) % 26);
  const tilt = ((n * 29) % 50) - 25;
  const haze = 0.18 + ((n * 7) % 10) / 50;
  const ground = 150 + ((n * 11) % 20);
  const id = `art-${contestant.id}`;

  return (
    <svg
      className="art art--placeholder"
      viewBox="0 0 160 200"
      role="img"
      aria-label={`Placeholder image for contestant ${contestant.number}`}
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2b2b2b" />
          <stop offset="100%" stopColor="#0c0c0c" />
        </linearGradient>
        <linearGradient id={`${id}-beam`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0.05" />
        </linearGradient>
        <radialGradient id={`${id}-pool`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.75" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="160" height="200" fill={`url(#${id}-bg)`} />
      <rect width="160" height="200" fill="#ffffff" opacity={haze * 0.35} />
      <g transform={`rotate(${tilt} ${beamX} 0)`}>
        <polygon
          points={`${beamX - 6},-10 ${beamX + 6},-10 ${beamX + beamWidth},${ground} ${beamX - beamWidth},${ground}`}
          fill={`url(#${id}-beam)`}
          opacity={0.55 + haze}
        />
      </g>
      <ellipse cx={beamX + tilt * -1.2} cy={ground} rx={beamWidth + 18} ry="14" fill={`url(#${id}-pool)`} />
      <rect y={ground + 8} width="160" height={200 - ground} fill="#000000" opacity="0.35" />
      {!compact && (
        <text
          x="80"
          y="96"
          textAnchor="middle"
          fontSize="8"
          fontWeight="500"
          letterSpacing="2"
          fill="#ffffff"
          fillOpacity="0.55"
        >
          PHOTO TO COME
        </text>
      )}
    </svg>
  );
}
