// Monte Carlo simulator for the Man/Gin/Guy competition.
//
// For each of SIMULATIONS runs: simulates every remaining regular-season
// game (using the win probabilities already computed in
// data/schedule-current.json), derives final records, seeds a 7-team
// playoff bracket per conference (simplified tiebreaker — see
// pickDivisionWinner_/rankByRecord_ below), simulates the bracket through
// the Super Bowl, and tallies each team's competition points for that run.
// Averaging across all runs gives "expected points": actual points already
// banked (since real completed games are identical in every run) plus a
// probability-weighted average of everything still undecided.
//
// NEW: alongside the season-long standings output, this now also computes
// each remaining game's TRUE conditional impact on each participant's
// playoff odds — P(team makes playoffs | team wins this specific game) vs
// P(team makes playoffs | team loses this specific game) — by tallying,
// within the SAME 10,000 trials already being run, which trials had that
// team winning vs losing that particular game, and what fraction of each
// subset resulted in a playoff berth. This is a real conditional
// probability estimated by Monte Carlo, not a client-side approximation —
// see data/playoff-leverage-current.json. No extra simulation passes are
// needed; it's bookkeeping added to the trial loop that was already
// running for the standings numbers.
//
// SCOPE NOTE: this models the *hypothetical* path from wherever the season
// currently stands. It doesn't yet special-case a real, already-underway
// playoff bracket (i.e. once actual postseason games start appearing in
// schedule-current.json with real matchups, this script will still run its
// own synthetic bracket rather than consuming ESPN's real one). That's fine
// through the regular season; revisit before the postseason itself starts
// if you want real playoff matchups to short-circuit the synthetic bracket.
//
// Run manually with: node scripts/simulate-season.mjs

import { promises as fs } from 'fs';
import path from 'path';
import { HOME_FIELD_ADV, marginToHomeWinProbability } from './lib/win-probability.mjs';
import { currentWeekKey, hasWeekStarted, upsertWeeklyArchive } from './lib/archive-window.mjs';

const DATA_DIR = path.resolve('data');
const ROSTERS_PATH = path.join(DATA_DIR, 'rosters.json');
const RATINGS_PATH = path.join(DATA_DIR, 'ratings-current.json');
const SCHEDULE_PATH = path.join(DATA_DIR, 'schedule-current.json');
const STANDINGS_CURRENT_PATH = path.join(DATA_DIR, 'standings-current.json');
const STANDINGS_ARCHIVE_PATH = path.join(DATA_DIR, 'standings-archive.json');
const LEVERAGE_CURRENT_PATH = path.join(DATA_DIR, 'playoff-leverage-current.json');
const LEVERAGE_ARCHIVE_PATH = path.join(DATA_DIR, 'playoff-leverage-archive.json');

const SIMULATIONS = 10000;

const POINTS = {
  win: 1,
  playoffs: 1,
  divisionTitle: 1,
  divisionalRound: 4,
  conferenceChampionship: 6,
  superBowlAppearance: 8,
  superBowlWin: 10,
};

// Static — doesn't change season to season. conf/div only, not standings.
const NFL_STRUCTURE = {
  BUF: { conf: 'AFC', div: 'East' }, MIA: { conf: 'AFC', div: 'East' }, NE: { conf: 'AFC', div: 'East' }, NYJ: { conf: 'AFC', div: 'East' },
  BAL: { conf: 'AFC', div: 'North' }, CIN: { conf: 'AFC', div: 'North' }, CLE: { conf: 'AFC', div: 'North' }, PIT: { conf: 'AFC', div: 'North' },
  HOU: { conf: 'AFC', div: 'South' }, IND: { conf: 'AFC', div: 'South' }, JAX: { conf: 'AFC', div: 'South' }, TEN: { conf: 'AFC', div: 'South' },
  DEN: { conf: 'AFC', div: 'West' }, KC: { conf: 'AFC', div: 'West' }, LV: { conf: 'AFC', div: 'West' }, LAC: { conf: 'AFC', div: 'West' },
  DAL: { conf: 'NFC', div: 'East' }, NYG: { conf: 'NFC', div: 'East' }, PHI: { conf: 'NFC', div: 'East' }, WSH: { conf: 'NFC', div: 'East' },
  CHI: { conf: 'NFC', div: 'North' }, DET: { conf: 'NFC', div: 'North' }, GB: { conf: 'NFC', div: 'North' }, MIN: { conf: 'NFC', div: 'North' },
  ATL: { conf: 'NFC', div: 'South' }, CAR: { conf: 'NFC', div: 'South' }, NO: { conf: 'NFC', div: 'South' }, TB: { conf: 'NFC', div: 'South' },
  ARI: { conf: 'NFC', div: 'West' }, LAR: { conf: 'NFC', div: 'West' }, SF: { conf: 'NFC', div: 'West' }, SEA: { conf: 'NFC', div: 'West' },
};

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function readJsonIfExists(filePath, fallback) {
  try {
    return await readJson(filePath);
  } catch {
    return fallback;
  }
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// Win% with a tiny random jitter so exact ties break randomly per-simulation
// rather than by array order. This stands in for the NFL's real (much
// deeper) tiebreaker chain — division/conference record, common games,
// strength of victory, net points, etc. — which isn't modeled here.
function rankByRecord_(abbrs, winPct) {
  return [...abbrs].sort((a, b) => (winPct[b] + Math.random() * 1e-9) - (winPct[a] + Math.random() * 1e-9));
}

function pickDivisionWinner_(divisionAbbrs, winPct) {
  return rankByRecord_(divisionAbbrs, winPct)[0];
}

// One coin-flip game between two teams' FPI ratings. homeAbbr may be null
// for a neutral-site game (Super Bowl) — no home-field adjustment applied.
function simulateGame_(homeAbbr, awayAbbr, fpiMap, neutralSite = false) {
  const margin = (fpiMap[homeAbbr] ?? 0) - (fpiMap[awayAbbr] ?? 0) + (neutralSite ? 0 : HOME_FIELD_ADV);
  const homeWinProb = marginToHomeWinProbability(margin);
  return Math.random() < homeWinProb ? homeAbbr : awayAbbr;
}

function seedConference_(confAbbrs, winPct) {
  const divisions = {};
  for (const abbr of confAbbrs) {
    const div = NFL_STRUCTURE[abbr].div;
    (divisions[div] ??= []).push(abbr);
  }

  const divisionWinners = Object.values(divisions).map((teams) => pickDivisionWinner_(teams, winPct));
  const seeds1to4 = rankByRecord_(divisionWinners, winPct); // seed order = best record among division winners

  const wildcardPool = confAbbrs.filter((a) => !divisionWinners.includes(a));
  const seeds5to7 = rankByRecord_(wildcardPool, winPct).slice(0, 3);

  return [...seeds1to4, ...seeds5to7]; // index 0 = 1-seed, ..., index 6 = 7-seed
}

// Simulates one conference's bracket. Returns { champion, achievements },
// where achievements[abbr] holds booleans for every round that abbr reached.
function simulateConferenceBracket_(seeds, fpiMap) {
  const achievements = {};
  seeds.forEach((abbr) => {
    achievements[abbr] = { divisionalRound: false, conferenceChampionship: false };
  });

  const [s1, s2, s3, s4, s5, s6, s7] = seeds;

  // Wild-card round: 2v7, 3v6, 4v5. Higher seed (lower number) hosts.
  const wc1Winner = simulateGame_(s2, s7, fpiMap);
  const wc2Winner = simulateGame_(s3, s6, fpiMap);
  const wc3Winner = simulateGame_(s4, s5, fpiMap);

  const seedNum = { [s1]: 1, [s2]: 2, [s3]: 3, [s4]: 4, [s5]: 5, [s6]: 6, [s7]: 7 };
  const wildcardWinners = [wc1Winner, wc2Winner, wc3Winner];

  // Divisional round: 1-seed (bye) hosts the lowest remaining seed;
  // the other two wild-card winners play each other, higher seed hosts.
  [s1, ...wildcardWinners].forEach((abbr) => { achievements[abbr].divisionalRound = true; });

  const sortedByDeed = [...wildcardWinners].sort((a, b) => seedNum[a] - seedNum[b]);
  const lowestRemaining = sortedByDeed[sortedByDeed.length - 1];
  const otherTwo = sortedByDeed.slice(0, sortedByDeed.length - 1);

  const div1Winner = simulateGame_(s1, lowestRemaining, fpiMap);
  const div2Winner = simulateGame_(otherTwo[0], otherTwo[1], fpiMap);

  // Conference championship: the two divisional-round winners, higher seed hosts.
  [div1Winner, div2Winner].forEach((abbr) => { achievements[abbr].conferenceChampionship = true; });
  const confHome = seedNum[div1Winner] < seedNum[div2Winner] ? div1Winner : div2Winner;
  const confAway = confHome === div1Winner ? div2Winner : div1Winner;
  const champion = simulateGame_(confHome, confAway, fpiMap);

  return { champion, achievements };
}

async function main() {
  const [rosters, ratings, schedule] = await Promise.all([
    readJson(ROSTERS_PATH),
    readJson(RATINGS_PATH),
    readJson(SCHEDULE_PATH),
  ]);

  const fpiMap = {};
  for (const t of ratings.teams ?? []) {
    if (t.team) fpiMap[t.team] = t.fpi ?? 0;
  }

  const allTeams = Object.keys(NFL_STRUCTURE);
  const missingFpi = allTeams.filter((abbr) => !(abbr in fpiMap));
  if (missingFpi.length) {
    console.warn(`WARNING: no FPI rating found for ${missingFpi.join(', ')} — treating as 0 (league average).`);
  }

  // Actual record from completed regular-season games so far.
  const actualWins = Object.fromEntries(allTeams.map((a) => [a, 0]));
  const actualLosses = Object.fromEntries(allTeams.map((a) => [a, 0]));

  const regularGames = (schedule.games ?? []).filter((g) => g.seasonType === 2);
  const completedGames = regularGames.filter((g) => g.status === 'Final');
  const remainingGames = regularGames.filter((g) => g.status !== 'Final');

  for (const g of completedGames) {
    if (g.homeScore === g.awayScore) {
      actualWins[g.homeTeam] += 0.5;
      actualWins[g.awayTeam] += 0.5;
    } else if (g.homeScore > g.awayScore) {
      actualWins[g.homeTeam] += 1;
      actualLosses[g.awayTeam] += 1;
    } else {
      actualWins[g.awayTeam] += 1;
      actualLosses[g.homeTeam] += 1;
    }
  }

  console.log(`Actual completed regular-season games: ${completedGames.length}. Remaining: ${remainingGames.length}.`);
  console.log(`Running ${SIMULATIONS} simulations...`);

  const pointSum = Object.fromEntries(allTeams.map((a) => [a, 0]));
  const simWinsSum = Object.fromEntries(allTeams.map((a) => [a, 0]));
  const tierCounts = Object.fromEntries(
    allTeams.map((a) => [a, { playoffs: 0, divisionTitle: 0, divisionalRound: 0, conferenceChampionship: 0, superBowlAppearance: 0, superBowlWin: 0 }])
  );

  // NEW: per-game, per-side conditional accumulators. For each remaining
  // game, tracks — across trials where the home team won vs. trials where
  // the home team lost — how many of each subset resulted in a playoff
  // berth for the home team, and separately for the away team. This is
  // exactly what "P(playoffs | win this game)" and "P(playoffs | lose this
  // game)" mean, estimated by counting within the same Monte Carlo trials
  // already being run for the standings numbers.
  const leverageAcc = Object.fromEntries(
    remainingGames.map((g) => [
      g.gameId,
      {
        home: { winTrials: 0, winPlayoffs: 0, lossTrials: 0, lossPlayoffs: 0 },
        away: { winTrials: 0, winPlayoffs: 0, lossTrials: 0, lossPlayoffs: 0 },
      },
    ])
  );

  for (let i = 0; i < SIMULATIONS; i++) {
    const wins = { ...actualWins };
    const losses = { ...actualLosses };

    // NEW: which side won each remaining game in THIS trial, recorded
    // alongside the existing win/loss tallying so it can be correlated
    // against this trial's playoff outcome further down.
    const homeWonThisTrial = {}; // gameId -> boolean

    for (const g of remainingGames) {
      const homeProb = g.homeWinProbability ?? 0.5;
      const homeWon = Math.random() < homeProb;
      homeWonThisTrial[g.gameId] = homeWon;
      if (homeWon) {
        wins[g.homeTeam] += 1;
        losses[g.awayTeam] += 1;
      } else {
        wins[g.awayTeam] += 1;
        losses[g.homeTeam] += 1;
      }
    }

    const winPct = {};
    for (const a of allTeams) {
      const games = wins[a] + losses[a];
      winPct[a] = games > 0 ? wins[a] / games : 0.5;
    }

    const afcAbbrs = allTeams.filter((a) => NFL_STRUCTURE[a].conf === 'AFC');
    const nfcAbbrs = allTeams.filter((a) => NFL_STRUCTURE[a].conf === 'NFC');

    const afcSeeds = seedConference_(afcAbbrs, winPct);
    const nfcSeeds = seedConference_(nfcAbbrs, winPct);

    const afcResult = simulateConferenceBracket_(afcSeeds, fpiMap);
    const nfcResult = simulateConferenceBracket_(nfcSeeds, fpiMap);

    const superBowlWinner = simulateGame_(afcResult.champion, nfcResult.champion, fpiMap, true);

    const divisionWinnersThisRun = new Set([...afcSeeds.slice(0, 4), ...nfcSeeds.slice(0, 4)]);
    const playoffTeamsThisRun = new Set([...afcSeeds, ...nfcSeeds]);
    const achievements = { ...afcResult.achievements, ...nfcResult.achievements };

    for (const abbr of allTeams) {
      simWinsSum[abbr] += wins[abbr];

      const madePlayoffs = playoffTeamsThisRun.has(abbr);
      const wonDivision = divisionWinnersThisRun.has(abbr);
      const reachedDivisionalRound = achievements[abbr]?.divisionalRound ?? false;
      const reachedConfChamp = achievements[abbr]?.conferenceChampionship ?? false;
      const reachedSuperBowl = abbr === afcResult.champion || abbr === nfcResult.champion;
      const wonSuperBowl = abbr === superBowlWinner;

      if (madePlayoffs) tierCounts[abbr].playoffs += 1;
      if (wonDivision) tierCounts[abbr].divisionTitle += 1;
      if (reachedDivisionalRound) tierCounts[abbr].divisionalRound += 1;
      if (reachedConfChamp) tierCounts[abbr].conferenceChampionship += 1;
      if (reachedSuperBowl) tierCounts[abbr].superBowlAppearance += 1;
      if (wonSuperBowl) tierCounts[abbr].superBowlWin += 1;

      const points =
        wins[abbr] * POINTS.win +
        (madePlayoffs ? POINTS.playoffs : 0) +
        (wonDivision ? POINTS.divisionTitle : 0) +
        (reachedDivisionalRound ? POINTS.divisionalRound : 0) +
        (reachedConfChamp ? POINTS.conferenceChampionship : 0) +
        (reachedSuperBowl ? POINTS.superBowlAppearance : 0) +
        (wonSuperBowl ? POINTS.superBowlWin : 0);

      pointSum[abbr] += points;
    }

    // NEW: now that this trial's playoff outcomes are known, correlate
    // each remaining game's actual outcome (recorded above) against
    // whether each participant made the playoffs in this same trial.
    for (const g of remainingGames) {
      const acc = leverageAcc[g.gameId];
      const homeWon = homeWonThisTrial[g.gameId];
      const homeMadePlayoffs = playoffTeamsThisRun.has(g.homeTeam);
      const awayMadePlayoffs = playoffTeamsThisRun.has(g.awayTeam);

      if (homeWon) {
        acc.home.winTrials += 1;
        if (homeMadePlayoffs) acc.home.winPlayoffs += 1;
        acc.away.lossTrials += 1;
        if (awayMadePlayoffs) acc.away.lossPlayoffs += 1;
      } else {
        acc.home.lossTrials += 1;
        if (homeMadePlayoffs) acc.home.lossPlayoffs += 1;
        acc.away.winTrials += 1;
        if (awayMadePlayoffs) acc.away.winPlayoffs += 1;
      }
    }
  }

  const teamResults = allTeams.map((abbr) => {
    const expectedPoints = Math.round((pointSum[abbr] / SIMULATIONS) * 100) / 100;
    const expectedFinalWins = Math.round((simWinsSum[abbr] / SIMULATIONS) * 100) / 100;
    const probs = tierCounts[abbr];
    return {
      team: abbr,
      owner: rosters.teams[abbr]?.owner ?? rosters.neutralLabel,
      pick: rosters.teams[abbr]?.pick ?? null,
      actualWins: actualWins[abbr],
      actualLosses: actualLosses[abbr],
      expectedFinalWins,
      expectedPoints,
      probabilities: {
        playoffs: Math.round((probs.playoffs / SIMULATIONS) * 1000) / 1000,
        divisionTitle: Math.round((probs.divisionTitle / SIMULATIONS) * 1000) / 1000,
        divisionalRound: Math.round((probs.divisionalRound / SIMULATIONS) * 1000) / 1000,
        conferenceChampionship: Math.round((probs.conferenceChampionship / SIMULATIONS) * 1000) / 1000,
        superBowlAppearance: Math.round((probs.superBowlAppearance / SIMULATIONS) * 1000) / 1000,
        superBowlWin: Math.round((probs.superBowlWin / SIMULATIONS) * 1000) / 1000,
      },
    };
  }).sort((a, b) => b.expectedPoints - a.expectedPoints);

  const ownerTotals = {};
  for (const t of teamResults) {
    ownerTotals[t.owner] = (ownerTotals[t.owner] ?? 0) + t.expectedPoints;
  }
  const ownerResults = Object.entries(ownerTotals)
    .map(([owner, expectedPoints]) => ({ owner, expectedPoints: Math.round(expectedPoints * 100) / 100 }))
    .sort((a, b) => b.expectedPoints - a.expectedPoints);

  const date = todayIso();
  const output = {
    date,
    season: rosters.season,
    simulations: SIMULATIONS,
    pointsSchema: POINTS,
    owners: ownerResults,
    teams: teamResults,
  };

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STANDINGS_CURRENT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${STANDINGS_CURRENT_PATH}`);

  // NEW: finalize the conditional playoff-odds percentages and write them
  // to their own file, separate from standings — this is a distinct kind
  // of output (per-game, not per-team-per-season) and keeping it separate
  // avoids bloating/complicating the standings file's existing consumers.
  // `null` for a side's ifWin/ifLoss means that outcome never happened
  // across all 10,000 trials for that game (extremely lopsided game),
  // not a bug — the dashboard should treat that as "no data" and fall
  // back to its own estimate for that one edge case.
  const pctOrNull = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
  const leverageGames = remainingGames.map((g) => {
    const acc = leverageAcc[g.gameId];
    return {
      gameId: g.gameId,
      week: g.week,
      date: g.date,
      home: g.homeTeam,
      away: g.awayTeam,
      homePlayoffOddsIfWin: pctOrNull(acc.home.winPlayoffs, acc.home.winTrials),
      homePlayoffOddsIfLoss: pctOrNull(acc.home.lossPlayoffs, acc.home.lossTrials),
      awayPlayoffOddsIfWin: pctOrNull(acc.away.winPlayoffs, acc.away.winTrials),
      awayPlayoffOddsIfLoss: pctOrNull(acc.away.lossPlayoffs, acc.away.lossTrials),
    };
  });
  const leverageOutput = {
    date,
    season: rosters.season,
    simulations: SIMULATIONS,
    games: leverageGames,
  };
  await fs.writeFile(LEVERAGE_CURRENT_PATH, JSON.stringify(leverageOutput, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${LEVERAGE_CURRENT_PATH} (${leverageGames.length} games)`);

  // Weekly-frozen archive: this script consumes the same schedule data it
  // loaded above, so "has this week started" is checked against that same
  // snapshot rather than re-fetching anything. Both standings and the new
  // leverage file follow the same freeze rule, using the same weekKey.
  const weekKey = currentWeekKey();
  const weekStarted = hasWeekStarted(schedule.games, weekKey);

  const standingsArchive = await readJsonIfExists(STANDINGS_ARCHIVE_PATH, []);
  const standingsResult = upsertWeeklyArchive(standingsArchive, weekKey, output, weekStarted);
  console.log(`[standings-archive] ${standingsResult.reason}`);
  if (standingsResult.changed) {
    await fs.writeFile(STANDINGS_ARCHIVE_PATH, JSON.stringify(standingsResult.archive, null, 2) + '\n', 'utf8');
  }

  const leverageArchive = await readJsonIfExists(LEVERAGE_ARCHIVE_PATH, []);
  const leverageResult = upsertWeeklyArchive(leverageArchive, weekKey, leverageOutput, weekStarted);
  console.log(`[playoff-leverage-archive] ${leverageResult.reason}`);
  if (leverageResult.changed) {
    await fs.writeFile(LEVERAGE_ARCHIVE_PATH, JSON.stringify(leverageResult.archive, null, 2) + '\n', 'utf8');
  }

  console.log('Owner standings:', ownerResults);
}

main().catch((err) => {
  console.error('Simulation failed:', err);
  process.exit(1);
});
