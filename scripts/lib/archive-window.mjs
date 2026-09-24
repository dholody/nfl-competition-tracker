// Shared logic for the "weekly, pre-kickoff" archive freeze used by
// update-fpi.mjs, update-schedule.mjs, and simulate-season.mjs.
//
// Archive behavior: "one entry per NFL week, frozen at the last update
// before that week's first kickoff". 
//
// The NFL week is defined as Tuesday 6:00 AM ET to the following Tuesday
// 6:00 AM ET (10:00 UTC). This guarantees that Monday Night Football games
// (which technically kick off on Tuesday in UTC) remain correctly assigned
// to the previous week's window.

/** Most recent Tuesday on/before `now` (adjusted for 10:00 AM UTC / 6:00 AM EDT boundary),
    as YYYY-MM-DD. Stable key for "which NFL week is this run happening during". */
export function currentWeekKey(now = new Date()) {
  // Shift time back by 10 hours so that anything before Tuesday 10:00 UTC 
  // (6:00 AM EDT) is still considered part of the previous week.
  const adjustedNow = new Date(now.getTime() - 10 * 60 * 60 * 1000);
  const d = new Date(Date.UTC(adjustedNow.getUTCFullYear(), adjustedNow.getUTCMonth(), adjustedNow.getUTCDate()));
  const day = d.getUTCDay(); // 0=Sun .. 6=Sat
  const diffToTuesday = (day - 2 + 7) % 7; // days since the most recent Tuesday
  d.setUTCDate(d.getUTCDate() - diffToTuesday);
  return d.toISOString().slice(0, 10);
}

/** True if any game with a kickoff inside the [weekStart, weekStart+7d) window
    has already kicked off as of `now`. `games` should have a `date` field
    (ISO kickoff timestamp) — works with schedule-current.json's `games`
    array or schedule-archive.json entries' `games` array. */
export function hasWeekStarted(games, weekKey, now = new Date()) {
  // Shift week start to 10:00:00Z (6:00 AM EDT) to avoid Monday Night Football bleeding over
  const weekStart = new Date(`${weekKey}T10:00:00Z`);
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
