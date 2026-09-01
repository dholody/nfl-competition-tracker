// Shared logic for the "weekly, pre-kickoff" archive freeze used by
// update-fpi.mjs, update-schedule.mjs, and simulate-season.mjs.
//
// Now that those scripts run DAILY (to keep *-current.json fresh with
// actual results as games complete), a plain "one archive entry per
// calendar date" guard would turn the archive into a daily log instead of
// a weekly one — and worse, it would happily record a snapshot on, say,
// Friday morning, after Thursday Night Football has already shifted FPI
// ratings, corrupting the "what did we know before any of this week's
// games were played" record.
//
// The fix: key each archive entry by NFL "week" (Tuesday-through-Monday,
// since Tuesday is the day after the last Monday Night game and before the
// next Thursday Night game — a reliable no-games gap every week), and only
// let a run write to that week's slot while none of that week's games have
// kicked off yet. Once the week's first kickoff passes, the slot is frozen:
// later daily runs that same week update *-current.json as normal, but
// leave the archive alone.

/** Most recent Tuesday on/before `now` (UTC), as YYYY-MM-DD. Stable key for
    "which NFL week is this run happening during". */
export function currentWeekKey(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay(); // 0=Sun .. 6=Sat
  const diffToTuesday = (day - 2 + 7) % 7; // days since the most recent Tuesday
  d.setUTCDate(d.getUTCDate() - diffToTuesday);
  return d.toISOString().slice(0, 10);
}

/** True if any game with a kickoff inside the [weekKey, weekKey+7d) window
    has already kicked off as of `now`. `games` should have a `date` field
    (ISO kickoff timestamp) — works with schedule-current.json's `games`
    array or schedule-archive.json entries' `games` array. */
export function hasWeekStarted(games, weekKey, now = new Date()) {
  const weekStart = new Date(`${weekKey}T00:00:00Z`);
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  return (games ?? []).some((g) => {
    if (!g?.date) return false;
    const kickoff = new Date(g.date);
    return kickoff >= weekStart && kickoff < weekEnd && kickoff <= now;
  });
}

/**
 * Writes `entry` into `archive` under `weekKey`, following the freeze rule:
 *  - Week hasn't started yet: upsert (overwrite if this week already has a
 *    pending entry, else append) — safe to keep refreshing right up to kickoff.
 *  - Week has started and already has a locked entry: no-op, archive
 *    untouched (this is the common case for most daily runs during a week).
 *  - Week has started but somehow has NO entry yet (e.g. the pipeline was
 *    down all week, or this is the very first run of the season): append a
 *    late one rather than losing the week entirely, flagged so it's
 *    distinguishable from a proper pre-kickoff snapshot.
 *
 * `entry` should NOT already include `weekKey` — this function adds it.
 * Returns { archive, changed, reason } — `archive` is the same array,
 * mutated in place AND returned, for convenient chaining.
 */
export function upsertWeeklyArchive(archive, weekKey, entry, weekStarted) {
  const idx = archive.findIndex((e) => e.weekKey === weekKey);

  if (weekStarted) {
    if (idx !== -1) {
      return { archive, changed: false, reason: `Week ${weekKey} is already locked in (games underway or complete) — archive left untouched.` };
    }
    archive.push({ ...entry, weekKey, lateSnapshot: true });
    return { archive, changed: true, reason: `Week ${weekKey} had no pre-kickoff snapshot on file — appended a late one (lateSnapshot: true).` };
  }

  if (idx === -1) {
    archive.push({ ...entry, weekKey });
    return { archive, changed: true, reason: `Appended first snapshot for week ${weekKey}.` };
  }
  archive[idx] = { ...entry, weekKey };
  return { archive, changed: true, reason: `Refreshed week ${weekKey}'s snapshot (still before any of that week's games have kicked off).` };
}
