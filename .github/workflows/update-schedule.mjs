// Fetches ESPN's scoreboard API for every preseason + regular season week,
// joins each game against data/ratings-current.json (by teamId, the same
// numeric ID scheme used throughout this repo) to compute a predicted
// margin, and writes current-state + weekly-frozen archive JSON into /data.
// Now run DAILY (via the update-fpi workflow's workflow_run chain, or
// manually with: node scripts/update-schedule.mjs) so schedule-current.json
// picks up actual scores/status promptly as games are played.
//
// WIN PROBABILITY SOURCE (changed): for every game that hasn't been played
// yet, this now fetches ESPN's own per-game "predictor" endpoint and uses
// THEIR win probability/predicted margin directly, instead of computing one
// from FPI ratings via this project's own normal-distribution model.
// Verified (see scripts/probe-espn-predictor.mjs and its real output) that
// ESPN's own model implies a narrower spread than this project's assumed
// σ=13.5 — their numbers consistently back-solve to roughly σ≈10.5, which
// alone explains a meaningful chunk of why this project's simulation used
// to disagree with ESPN's own playoff odds. Rather than try to reverse-
// engineer ESPN's exact model, this just uses their number directly.
//
// This is a real change in request volume: one HTTP call per upcoming
// game (up to ~270 early in the season) instead of ~22 bulk per-week
// scoreboard calls. Two things keep this safe: (1) only NOT-YET-PLAYED
// games are fetched this way — completed games keep using the FPI-based
// calculation for predictedMargin/predictionError, since there's no
// upcoming-game prediction left to fetch for those, and the request count
// naturally shrinks as the season progresses; (2) requests are concurrency-
// limited (not fired all at once) and every per-game failure falls back to
// this project's own FPI-based calculation rather than leaving the game
// unpredicted or failing the whole run — see fetchEspnPredictions_ below.
//
// predictedMargin = (homeFpi - awayFpi) + HOME_FIELD_ADV as a fallback, OR
// ESPN's own predicted margin when available. actualMargin uses the same
// sign convention (homeScore - awayScore) so predictionError = actualMargin
// - predictedMargin is directly comparable either way.
//
// Archive behavior: "one entry per NFL week, frozen at the last update
// before that week's first kickoff" — see lib/archive-window.mjs.

import { promises as fs } from 'fs';
import path from 'path';
import { HOME_FIELD_ADV, marginToHomeWinProbability } from './lib/win-probability.mjs';
import { currentWeekKey, hasWeekStarted, upsertWeeklyArchive } from './lib/archive-window.mjs';

const DATA_DIR = path.resolve('data');
const RATINGS_CURRENT_PATH = path.join(DATA_DIR, 'ratings-current.json');

// Preseason (seasontype 1) weeks 1-4, regular season (seasontype 2) weeks 1-18.
// Add {type: 3, week: 1..5} here later if you want postseason included.
const WEEKS_TO_FETCH = [
  ...[1, 2, 3, 4].map((week) => ({ type: 1, week })),
  ...Array.from({ length: 18 }, (_, i) => ({ type: 2, week: i + 1 })),
];

// How many predictor requests to run concurrently. Not "as fast as
// possible" on purpose — 272 simultaneous requests to an API that's
// already shown bot-detection behavior elsewhere in this project is asking
// for trouble. This many at a time, plus a small per-request stagger
// inside each worker, keeps this well clear of that.
const PREDICTOR_CONCURRENCY = 6;
const PREDICTOR_STAGGER_MS = 75;

const FETCH_HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; nfl-competition-tracker/1.0)' };

function detectSeason(date = new Date()) {
  const month = date.getUTCMonth() + 1; // 1-12
  const year = date.getUTCFullYear();
  return month >= 8 ? year : year - 1;
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Fetch failed (${res.status}) for ${url}`);
  }
  return res.json();
}

function scoreboardUrl(seasonType, week, year) {
  return (
    'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard' +
    `?seasontype=${seasonType}&week=${week}&dates=${year}`
  );
}

function predictorUrl(gameId) {
  return (
    `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${gameId}` +
    `/competitions/${gameId}/predictor`
  );
}

function parseEvent(ev) {
  const comp = ev?.competitions?.[0];
  if (!comp) return null;

  const competitors = comp.competitors ?? [];
  const home = competitors.find((c) => c.homeAway === 'home');
  const away = competitors.find((c) => c.homeAway === 'away');
  if (!home || !away) return null;

  const statusType = comp.status?.type ?? ev.status?.type ?? {};

  return {
    id: ev.id,
    seasonYear: ev.season?.year ?? null,
    seasonType: ev.season?.type ?? null, // 1=pre, 2=reg, 3=post
    week: ev.week?.number ?? null,
    dateIso: ev.date, // UTC ISO string
    homeTeamId: home.team?.id ?? null,
    awayTeamId: away.team?.id ?? null,
    homeTeam: home.team?.abbreviation ?? null,
    awayTeam: away.team?.abbreviation ?? null,
    homeScore: home.score !== undefined && home.score !== '' ? Number(home.score) : null,
    awayScore: away.score !== undefined && away.score !== '' ? Number(away.score) : null,
    completed: !!statusType.completed,
    statusDescription: statusType.description ?? '',
  };
}

async function fetchAllGames(year) {
  const responses = await Promise.all(
    WEEKS_TO_FETCH.map(({ type, week }) =>
      fetchJson(scoreboardUrl(type, week, year)).catch((err) => {
        console.error(`Failed to fetch seasontype=${type} week=${week}:`, err.message);
        return null;
      })
    )
  );

  const byId = new Map(); // dedupe in case of overlapping week boundaries
  for (const json of responses) {
    if (!json || !Array.isArray(json.events)) continue;
    for (const ev of json.events) {
      const parsed = parseEvent(ev);
      if (parsed) byId.set(parsed.id, parsed);
    }
  }
  return Array.from(byId.values());
}

/** Pulls { name, value } out of a predictor response's statistics array
    for one side (home or away). */
function getStatValue_(statisticsArray, name) {
  const stat = statisticsArray?.find((s) => s.name === name);
  return stat ? stat.value : null;
}

/** Parses one game's predictor response into the fields this script cares
    about, or null if the response is missing what we need (triggers the
    FPI fallback for that game). Verified against a real captured response
    — see scripts/probe-espn-predictor.mjs's saved output. */
function parsePredictorResponse_(json) {
  const homeWinProbRaw = getStatValue_(json?.homeTeam?.statistics, 'gameProjection');
  const awayWinProbRaw = getStatValue_(json?.awayTeam?.statistics, 'gameProjection');
  const homeMarginRaw = getStatValue_(json?.homeTeam?.statistics, 'teamPredPtDiff');
  if (homeWinProbRaw == null || awayWinProbRaw == null) return null;

  return {
    homeWinProbability: Math.round((homeWinProbRaw / 100) * 1000) / 1000,
    awayWinProbability: Math.round((awayWinProbRaw / 100) * 1000) / 1000,
    predictedMargin: homeMarginRaw != null ? Math.round(homeMarginRaw * 10) / 10 : null,
  };
}

/** Runs `fn` over `items` with at most `concurrency` in flight at once,
    each worker pausing `staggerMs` between its own requests. Simple pool,
    not a library — this project doesn't need anything fancier than "don't
    fire 270 requests at the same instant". */
async function mapWithConcurrencyLimit_(items, concurrency, staggerMs, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
      if (staggerMs > 0) await new Promise((r) => setTimeout(r, staggerMs));
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Fetches ESPN's own predictor for every NOT-YET-PLAYED game. Returns a
    Map(gameId -> parsed prediction). A game simply absent from the map
    means it fell back to the FPI-based calculation — logged, not thrown,
    since a fallback exists and one bad game shouldn't fail the whole run. */
async function fetchEspnPredictions_(upcomingGames) {
  if (!upcomingGames.length) return new Map();

  console.log(`Fetching ESPN's own predictor for ${upcomingGames.length} upcoming games (concurrency ${PREDICTOR_CONCURRENCY})...`);
  let failures = 0;
  const results = await mapWithConcurrencyLimit_(upcomingGames, PREDICTOR_CONCURRENCY, PREDICTOR_STAGGER_MS, async (game) => {
    try {
      const json = await fetchJson(predictorUrl(game.id), FETCH_HEADERS);
      const parsed = parsePredictorResponse_(json);
      if (!parsed) {
        failures++;
        return null;
      }
      return { gameId: game.id, ...parsed };
    } catch (err) {
      failures++;
      console.error(`  predictor fetch failed for game ${game.id} (${game.awayTeam}@${game.homeTeam}): ${err.message}`);
      return null;
    }
  });

  const map = new Map();
  for (const r of results) { if (r) map.set(r.gameId, r); }

  console.log(`ESPN predictor: ${map.size}/${upcomingGames.length} succeeded, ${failures} fell back to FPI-based calculation.`);
  return map;
}

async function readJsonIfExists(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function loadFpiMap() {
  const ratings = await readJsonIfExists(RATINGS_CURRENT_PATH, null);
  if (!ratings) {
    console.warn(
      `WARNING: ${RATINGS_CURRENT_PATH} not found. Run scripts/update-fpi.mjs first, ` +
      `or trigger this via workflow_run after Update NFL FPI Data. Predicted margins will be null.`
    );
    return new Map();
  }
  const map = new Map();
  for (const t of ratings.teams ?? []) {
    if (t.teamId != null && t.fpi != null) map.set(String(t.teamId), t.fpi);
  }
  // Defense in depth: update-fpi.mjs itself now refuses to write a
  // near-empty ratings file, so this shouldn't normally trigger — but if
  // it somehow does (a manually edited file, a future bug elsewhere),
  // better to fail loudly here too than silently predict every game as a
  // 50/50 coin flip. Also still needed here even with the ESPN predictor
  // change: it's the fallback for whichever games ESPN's endpoint fails
  // for, and it's still what's used for completed games' predictionError.
  if (map.size < 28) {
    throw new Error(
      `ratings-current.json only has usable FPI for ${map.size}/32 teams — refusing to proceed. ` +
      `Predicted margins/win probabilities for most games would default to a 50/50 coin flip, ` +
      `which would silently corrupt schedule-current.json for everything downstream.`
    );
  }
  return map;
}

function buildRecord(game, fpiMap, espnPrediction) {
  const homeFpi = fpiMap.get(String(game.homeTeamId));
  const awayFpi = fpiMap.get(String(game.awayTeamId));
  const fpiPredictedMargin =
    homeFpi !== undefined && awayFpi !== undefined
      ? Math.round((homeFpi - awayFpi + HOME_FIELD_ADV) * 10) / 10
      : null;

  // Prefer ESPN's own prediction for games that aren't decided yet; fall
  // back to this project's FPI-based calculation if ESPN's fetch didn't
  // succeed for this game, or for completed games (no upcoming prediction
  // to fetch for those — predictionError below still wants a predicted
  // value to compare the actual result against).
  let predictedMargin, homeWinProbability, awayWinProbability, predictionSource;
  if (!game.completed && espnPrediction) {
    predictedMargin = espnPrediction.predictedMargin ?? fpiPredictedMargin;
    homeWinProbability = espnPrediction.homeWinProbability;
    awayWinProbability = espnPrediction.awayWinProbability;
    predictionSource = 'espn';
  } else if (fpiPredictedMargin !== null) {
    predictedMargin = fpiPredictedMargin;
    homeWinProbability = Math.round(marginToHomeWinProbability(fpiPredictedMargin) * 1000) / 1000;
    awayWinProbability = Math.round((1 - homeWinProbability) * 1000) / 1000;
    predictionSource = game.completed ? 'fpi-retrospective' : 'fpi-fallback';
  } else {
    predictedMargin = null;
    homeWinProbability = null;
    awayWinProbability = null;
    predictionSource = 'none';
  }

  let actualMargin = null;
  let predictionError = null;
  if (game.completed && game.homeScore !== null && game.awayScore !== null) {
    actualMargin = game.homeScore - game.awayScore;
    if (predictedMargin !== null) {
      predictionError = Math.round((actualMargin - predictedMargin) * 10) / 10;
    }
  }

  return {
    gameId: game.id,
    season: game.seasonYear,
    seasonType: game.seasonType,
    week: game.week,
    date: game.dateIso,
    awayTeamId: game.awayTeamId,
    homeTeamId: game.homeTeamId,
    awayTeam: game.awayTeam,
    homeTeam: game.homeTeam,
    status: game.completed ? 'Final' : game.statusDescription || 'Scheduled',
    awayScore: game.awayScore,
    homeScore: game.homeScore,
    actualMargin,
    awayFpi: awayFpi ?? null,
    homeFpi: homeFpi ?? null,
    predictedMargin,
    predictionError,
    homeWinProbability,
    awayWinProbability,
    predictionSource, // 'espn' | 'fpi-fallback' | 'fpi-retrospective' | 'none' — transparency for debugging
  };
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function todayIso() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function main() {
  const season = detectSeason();
  console.log(`Running schedule update for season ${season}...`);

  const [games, fpiMap] = await Promise.all([fetchAllGames(season), loadFpiMap()]);
  console.log(`Fetched ${games.length} games. FPI ratings loaded for ${fpiMap.size} teams.`);

  const upcomingGames = games.filter((g) => !g.completed);
  const espnPredictions = await fetchEspnPredictions_(upcomingGames);

  const records = games
    .map((g) => buildRecord(g, fpiMap, espnPredictions.get(g.id)))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const date = todayIso();

  // Current snapshot (overwritten every run — this is what should update
  // daily so actual scores/status show up promptly as games are played).
  await writeJson(path.join(DATA_DIR, 'schedule-current.json'), { date, season, games: records });

  // Weekly-frozen archive: determine "has this week started" directly from
  // the fresh data we just fetched, then upsert/lock accordingly.
  const weekKey = currentWeekKey();
  const weekStarted = hasWeekStarted(records, weekKey);

  const archivePath = path.join(DATA_DIR, 'schedule-archive.json');
  const archive = await readJsonIfExists(archivePath, []);
  const result = upsertWeeklyArchive(archive, weekKey, { date, season, games: records }, weekStarted);
  console.log(`[schedule-archive] ${result.reason}`);
  if (result.changed) await writeJson(archivePath, result.archive);

  console.log('Done.');
}

main().catch((err) => {
  console.error('Update failed:', err);
  process.exit(1);
});
