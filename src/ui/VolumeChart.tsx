import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { formatSgtAxis, formatSgtShort, sgtDay } from '../domain/time';
import type { VolumeBucket } from '../domain/types';

interface Props {
  buckets: readonly VolumeBucket[];
  bucketMinutes: number;
}

const WIDTH = 680;
const HEIGHT = 220;
const MARGIN = { top: 24, right: 12, bottom: 28, left: 40 };
const MAX_COLUMN = 24;
const GAP = 2;

/** Rounds the axis top up to a clean number, so ticks read 0 / 5 / 10 and not 0 / 3.67 / 7.33. */
function niceCeiling(value: number): number {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 4, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

function bucketLabel(minutes: number): string {
  if (minutes === 60) return 'hour';
  return minutes % 60 === 0 ? `${minutes / 60} hours` : `${minutes} minutes`;
}

/**
 * Votes received per time bucket, as columns.
 *
 * One series, so one colour and no legend: the heading says what is plotted.
 * Only the peak is labelled; every other value is in the tooltip (hover, or
 * arrow keys once the chart has focus) and in the table underneath.
 */
export function VolumeChart({ buckets, bucketMinutes }: Props): JSX.Element {
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();

  const layout = useMemo(() => {
    const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
    const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
    const peak = buckets.reduce((max, bucket) => Math.max(max, bucket.votes), 0);
    const top = niceCeiling(peak);
    const slot = buckets.length === 0 ? plotWidth : plotWidth / buckets.length;
    const column = Math.max(1, Math.min(MAX_COLUMN, slot - GAP));
    const peakIndex = peak === 0 ? -1 : buckets.findIndex((bucket) => bucket.votes === peak);
    // Aim for about six labels, whatever the number of buckets. The date is
    // spelled out on the first one and again whenever the day has changed.
    const labelEvery = Math.max(1, Math.ceil(buckets.length / 6));
    const labels = new Map<number, string>();
    let day = '';
    buckets.forEach((bucket, index) => {
      if (index % labelEvery !== 0) return;
      const bucketDay = sgtDay(bucket.start);
      labels.set(index, formatSgtAxis(bucket.start, bucketDay !== day));
      day = bucketDay;
    });
    return { plotWidth, plotHeight, top, slot, column, peakIndex, labels };
  }, [buckets]);

  if (buckets.length === 0 || layout.peakIndex === -1) {
    return <p className="hint">No votes yet. The chart appears with the first vote.</p>;
  }

  const { plotWidth, plotHeight, top, slot, column, peakIndex, labels } = layout;
  const x = (index: number): number => MARGIN.left + index * slot + (slot - column) / 2;
  const y = (votes: number): number => MARGIN.top + plotHeight * (1 - votes / top);
  const ticks = [0, top / 2, top];
  const focused = active === null ? null : buckets[active];

  const onKeyDown = (keyEvent: KeyboardEvent<SVGSVGElement>): void => {
    if (keyEvent.key !== 'ArrowLeft' && keyEvent.key !== 'ArrowRight') return;
    keyEvent.preventDefault();
    const step = keyEvent.key === 'ArrowLeft' ? -1 : 1;
    setActive((current) =>
      Math.min(buckets.length - 1, Math.max(0, (current ?? peakIndex) + step)),
    );
  };

  return (
    <figure className="chart">
      <div className="chart__plot">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-labelledby={titleId}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onFocus={() => setActive((current) => current ?? peakIndex)}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
        >
          <title id={titleId}>
            {`Votes received per ${bucketLabel(bucketMinutes)}. Busiest: ${buckets[peakIndex]?.votes ?? 0} votes in the ${bucketLabel(bucketMinutes)} from ${formatSgtShort(buckets[peakIndex]?.start ?? '')}. Use the left and right arrow keys to read each column.`}
          </title>

          {ticks.map((tick) => (
            <g key={tick}>
              <line
                className="chart__grid"
                x1={MARGIN.left}
                x2={MARGIN.left + plotWidth}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text className="chart__tick" x={MARGIN.left - 8} y={y(tick)} textAnchor="end" dy="0.32em">
                {tick.toLocaleString('en-SG')}
              </text>
            </g>
          ))}

          {buckets.map((bucket, index) => {
            const height = MARGIN.top + plotHeight - y(bucket.votes);
            const radius = Math.min(4, column / 2, height);
            const left = x(index);
            const base = MARGIN.top + plotHeight;
            return (
              <g key={bucket.start}>
                {bucket.votes > 0 && (
                  // Rounded at the data end, square at the baseline.
                  <path
                    className={`chart__column${active === index ? ' chart__column--active' : ''}`}
                    d={`M${left},${base} V${base - height + radius} Q${left},${base - height} ${left + radius},${base - height} H${left + column - radius} Q${left + column},${base - height} ${left + column},${base - height + radius} V${base} Z`}
                  />
                )}
                {index === peakIndex && (
                  <text
                    className="chart__value"
                    x={left + column / 2}
                    y={y(bucket.votes) - 6}
                    textAnchor="middle"
                  >
                    {bucket.votes.toLocaleString('en-SG')}
                  </text>
                )}
                {labels.has(index) && (
                  <text
                    className="chart__tick"
                    x={index === 0 ? left : left + column / 2}
                    y={HEIGHT - 8}
                    textAnchor={index === 0 ? 'start' : 'middle'}
                  >
                    {labels.get(index)}
                  </text>
                )}
                {/* The whole slot, top to bottom, is the hit target: a short column is still easy to hit. */}
                <rect
                  className="chart__hit"
                  x={MARGIN.left + index * slot}
                  y={MARGIN.top}
                  width={slot}
                  height={plotHeight}
                  onPointerEnter={() => setActive(index)}
                  onPointerDown={() => setActive(index)}
                />
              </g>
            );
          })}
        </svg>

        {focused !== null && focused !== undefined && active !== null && (
          <p
            className="chart__tooltip"
            style={{
              left: `${((x(active) + column / 2) / WIDTH) * 100}%`,
              top: `${(y(focused.votes) / HEIGHT) * 100}%`,
            }}
            role="status"
          >
            <strong>
              {focused.votes.toLocaleString('en-SG')} {focused.votes === 1 ? 'vote' : 'votes'}
            </strong>
            <span>from {formatSgtShort(focused.start)}</span>
          </p>
        )}
      </div>

      <details className="chart__table">
        <summary>Show as a table</summary>
        <table className="preview">
          <thead>
            <tr>
              <th scope="col">{`${bucketLabel(bucketMinutes)} starting (SGT)`}</th>
              <th scope="col" className="preview__num">
                Votes
              </th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket) => (
              <tr key={bucket.start}>
                <td>{formatSgtShort(bucket.start)}</td>
                <td className="preview__num">{bucket.votes.toLocaleString('en-SG')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
