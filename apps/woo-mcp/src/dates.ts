// Turns "today" / "yesterday" / "YYYY-MM-DD" into a WooCommerce after/before range. WooCommerce
// reads after/before (without dates_are_gmt) in the store's own timezone, so "today" must be
// the store's today, not the pod's (pods run in UTC).

export interface DayRange {
  after: string;
  before: string;
  day: string;
}

/** gmtOffsetHours is WordPress's gmt_offset option (e.g. 5.5 for India, -7 for PDT). */
export function resolveDay(day: string, gmtOffsetHours: number, now: Date = new Date()): DayRange {
  let date: string;
  const keyword = day.trim().toLowerCase();
  if (keyword === 'today' || keyword === 'yesterday') {
    const local = new Date(now.getTime() + gmtOffsetHours * 3_600_000);
    if (keyword === 'yesterday') local.setUTCDate(local.getUTCDate() - 1);
    date = local.toISOString().slice(0, 10);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(keyword) && !Number.isNaN(Date.parse(keyword))) {
    date = keyword;
  } else {
    throw new Error(`Invalid date '${day}'. Use "today", "yesterday" or YYYY-MM-DD.`);
  }
  // `after`/`before` are exclusive in WooCommerce, so bracket the whole day.
  const previous = new Date(`${date}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return {
    day: date,
    after: `${previous.toISOString().slice(0, 10)}T23:59:59`,
    before: `${next.toISOString().slice(0, 10)}T00:00:00`,
  };
}
