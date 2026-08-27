// Fetches ESPN's scoreboard API for every preseason + regular season week,
// joins each game against data/ratings-current.json (by teamId, the same
// numeric ID scheme used throughout this repo) to compute a predicted
// margin, and writes current-state + append-only archive JSON into /data.
// Run by the weekly GitHub Actions workflow (or manually with:
// node scripts/update-schedule.mjs).
//
// predictedMargin = (homeFpi - awayFpi) + HOME_FIELD_ADV, positive = home
// favored. actualMargin uses the same sign convention (homeScore -
// awayScore) so predictionError = actualMargin - predictedMargin is
// directly comparable.
//
// Mirrors update-fpi.mjs's structure (fetchJson/writeJson/appendArchive
// helpers, detectSeason threshold, archive dedup-by-date) for consistency.

import { promises as fs } from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('data');
const RATINGS_CURRENT_PATH = path.join(DATA_DIR, 'ratings-current.json');

const HOME_FIELD_ADV = 2.0;

// Preseason (seasontype 1) weeks 1-4, regular season (seasontype 2) weeks 1-18.
// Add {type: 3, week: 1..5} here later if you want postseason included.
const WEEKS_TO_FETCH = [
  ...[1, 2, 3, 4].map((week) => ({ type: 1, week })),
  ...Array.from({ length: 18 }, (_, i) => ({ type: 2, week: i + 1 })),
];

function detectSeason(date = new Date()) {
  const month = date.getUTCMonth() + 1; // 1-12
  const year = date.getUTCFullYear();
  return month >= 8 ? year : year - 1;
}

async function fetchJson(url) {
  const res = await fetch(url);
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
  return map;
}

function buildRecord(game, fpiMap) {
  const homeFpi = fpiMap.get(String(game.homeTeamId));
  const awayFpi = fpiMap.get(String(game.awayTeamId));
  const predictedMargin =
    homeFpi !== undefined && awayFpi !== undefined
      ? Math.round((homeFpi - awayFpi + HOME_FIELD_ADV) * 10) / 10
      : null;

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
  };
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function todayIso() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function appendArchive(filePath, todayEntry) {
  const archive = await readJsonIfExists(filePath, []);
  const already = archive.some((entry) => entry.date === todayEntry.date);
  if (already) {
    console.log(`Archive ${filePath} already has an entry for ${todayEntry.date}, skipping append.`);
    return archive;
  }
  archive.push(todayEntry);
  return archive;
}

async function main() {
  const season = detectSeason();
  console.log(`Running schedule update for season ${season}...`);

  const [games, fpiMap] = await Promise.all([fetchAllGames(season), loadFpiMap()]);
  console.log(`Fetched ${games.length} games. FPI ratings loaded for ${fpiMap.size} teams.`);

  const records = games
    .map((g) => buildRecord(g, fpiMap))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const date = todayIso();

  // Current snapshot (overwritten each run)
  await writeJson(path.join(DATA_DIR, 'schedule-current.json'), { date, season, games: records });

  // Append-only archive, guarded against duplicate same-day runs
  const archivePath = path.join(DATA_DIR, 'schedule-archive.json');
  const archive = await appendArchive(archivePath, { date, season, games: records });
  await writeJson(archivePath, archive);

  console.log('Done.');
}

main().catch((err) => {
  console.error('Update failed:', err);
  process.exit(1);
});
