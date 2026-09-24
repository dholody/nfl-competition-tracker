// One-off diagnostic — NOT part of the pipeline. Run this once, read the
// output, and report back what it prints so real integration code can be
// written against the ACTUAL response shape rather than a guess.
//
// Why this exists: the dashboard's win probabilities are all computed from
// each team's single current FPI rating (data/ratings-current.json). If
// ESPN's rating reflects real-time state (e.g. an injured starter) while
// their own playoff/SB odds account for an expected return, then ESPN
// must be using some per-game-specific number for future matchups that
// differs from the static season FPI. Two endpoints, documented by
// third-party ESPN API reverse-engineering efforts (not something ESPN
// publishes officially, so treat the exact field names below as "probably
// right" rather than guaranteed) look like plausible candidates:
//   - .../events/{id}/competitions/{id}/predictor       (matchup projection)
//   - .../events/{id}/competitions/{id}/powerindex/{tid} (per-game power index)
//
// This script hits both for a small sample of real upcoming games from
// your current schedule and prints the raw JSON so we can see which
// fields actually exist, and whether the per-game number differs from the
// season-long FPI in ratings-current.json in the way the injury-return
// theory would predict.
//
// Run with: node scripts/probe-espn-predictor.mjs
// (Run this somewhere with real internet access — a sandboxed dev
// environment may block sports.core.api.espn.com even though ESPN itself
// isn't blocking the request.)

import { promises as fs } from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('data');

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; nfl-competition-tracker research script)' },
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, body: text.slice(0, 500) };
  }
  try {
    return { ok: true, status: res.status, json: JSON.parse(text) };
  } catch (err) {
    return { ok: false, status: res.status, body: text.slice(0, 500), parseError: String(err) };
  }
}

async function main() {
  const schedule = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'schedule-current.json'), 'utf8'));
  const ratings = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'ratings-current.json'), 'utf8'));
  const fpiByAbbr = Object.fromEntries((ratings.teams ?? []).map(t => [t.team, t.fpi]));

  const upcoming = (schedule.games ?? [])
    .filter(g => g.seasonType === 2 && g.status !== 'Final')
    .slice(0, 3); // just a handful — this is a probe, not a full pull

  if (!upcoming.length) {
    console.log('No upcoming games found in schedule-current.json — nothing to probe.');
    return;
  }

  for (const g of upcoming) {
    console.log('='.repeat(70));
    console.log(`${g.awayTeam} @ ${g.homeTeam} — Week ${g.week} — gameId ${g.gameId}`);
    console.log(`Current season FPI — ${g.homeTeam}: ${fpiByAbbr[g.homeTeam]}, ${g.awayTeam}: ${fpiByAbbr[g.awayTeam]}`);
    console.log(`This dashboard's own predicted margin/win%: ${g.predictedMargin} / ${g.homeWinProbability}`);
    console.log();

    const predictorUrl = `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${g.gameId}/competitions/${g.gameId}/predictor`;
    console.log(`--- predictor endpoint ---`);
    console.log(predictorUrl);
    const predictorRes = await fetchJson(predictorUrl);
    if (predictorRes.ok) {
      console.log(JSON.stringify(predictorRes.json, null, 2));
    } else {
      console.log(`FAILED (status ${predictorRes.status}):`, predictorRes.body || predictorRes.parseError);
    }
    console.log();

    for (const [side, teamId] of [['home', g.homeTeamId], ['away', g.awayTeamId]]) {
      const powerIndexUrl = `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${g.gameId}/competitions/${g.gameId}/powerindex/${teamId}`;
      console.log(`--- event-scoped powerindex (${side}, teamId ${teamId}) ---`);
      console.log(powerIndexUrl);
      const piRes = await fetchJson(powerIndexUrl);
      if (piRes.ok) {
        console.log(JSON.stringify(piRes.json, null, 2));
      } else {
        console.log(`FAILED (status ${piRes.status}):`, piRes.body || piRes.parseError);
      }
      console.log();
    }
  }

  console.log('='.repeat(70));
  console.log('Probe complete. Paste this output back so real integration code can be written against it.');
}

main().catch((err) => {
  console.error('Probe script failed:', err);
  process.exit(1);
});
