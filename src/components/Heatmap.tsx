// Heatmap — last 12 weeks, one cell per day, intensity by focus minutes.
// Hand-rolled SVG (simpler and prettier than coercing a chart library into it).

interface HeatmapProps {
  data: Map<string, number>; // YYYY-MM-DD -> minutes that day
}

const CELL = 12;
const GAP = 3;
const WEEKS = 12;

const DAY_MS = 24 * 60 * 60 * 1000;

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const dd = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function intensityClass(min: number): string {
  if (min === 0) return 'h-0';
  if (min < 25) return 'h-1';
  if (min < 60) return 'h-2';
  if (min < 120) return 'h-3';
  return 'h-4';
}

export function Heatmap({ data }: HeatmapProps) {
  // Lay out 7 rows (days of week) x 12 columns (weeks).
  // Anchor on today; walk backward 12 weeks aligned to Sunday.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const lastSunday = new Date(today.getTime() - today.getDay() * DAY_MS);
  // The most recent column is the current week; oldest is 11 weeks before that.
  const oldestSunday = new Date(lastSunday.getTime() - (WEEKS - 1) * 7 * DAY_MS);

  const cells: { date: Date; min: number }[] = [];
  for (let col = 0; col < WEEKS; col++) {
    for (let row = 0; row < 7; row++) {
      const d = new Date(oldestSunday.getTime() + (col * 7 + row) * DAY_MS);
      // Cells after today are hidden (future).
      const min = d <= today ? data.get(dateKey(d)) ?? 0 : -1;
      cells.push({ date: d, min });
    }
  }

  const width = WEEKS * (CELL + GAP);
  const height = 7 * (CELL + GAP);

  return (
    <svg width={width} height={height} className="heatmap" role="img" aria-label="Focus minutes per day, last 12 weeks">
      {cells.map((c, i) => {
        const col = Math.floor(i / 7);
        const row = i % 7;
        if (c.min < 0) return null;
        return (
          <rect
            key={i}
            x={col * (CELL + GAP)}
            y={row * (CELL + GAP)}
            width={CELL}
            height={CELL}
            rx={2}
            className={`heatmap-cell ${intensityClass(c.min)}`}
          >
            <title>
              {c.date.toLocaleDateString()} — {c.min} min
            </title>
          </rect>
        );
      })}
    </svg>
  );
}
