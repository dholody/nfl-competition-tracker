// Fetches ESPN's FPI ratings + projections API, writes current-state and
// append-only archive JSON files into /data. Run by the weekly GitHub
// Actions workflow (or manually with: node scripts/update-fpi.mjs).
//
// Field names below are confirmed against ESPN's live response (predictives
// array, one entry per stat, keyed by `name`). If ESPN renames a field in
// the future, add the new name to the front of that field's candidate array
// below (first match wins) rather than replacing it outright — that keeps
// this resilient to upstream changes the same way the original Apps Script
// version was.

import { promises as fs } from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('data');

const RATING_FIELD_CANDIDATES = {
  fpi: ['fpi'],
  rank: ['fpirank'],
  offense: ['epaoffense'],
  defense: ['epadefense'],
  specialTeams: ['epaspecialteams'],
  trend: ['rankchange7days'],
};

const PROJECTION_FIELD_CANDIDATES = {
  projectedWins: ['projectedw'],
  projectedLosses: ['projectedl'],
  playoffOdds: ['probmakeplayoffs'],
  divisionOdds: ['probwindiv'],
  conferenceOdds: ['probmakeconfchamp'],
  superBowlOdds: ['probwintitle'],
};

function detectSeason(date = new Date()) {
  const month = date.getUTCMonth() + 1; // 1-12
  const year = date.getUTCFullYear();
  return month >= 8 ? year : year - 1;
}

// ESPN returns per-team data as a flat array under `predictives`, each entry
// shaped like { name, value, displayValue, ... }. This indexes that array by
// name so extraction is a simple lookup instead of guesswork.
function statsMap(raw) {
  const list = raw?.predictives ?? [];
  const map = {};
  for (const entry of list) {
    if (entry?.name) map[entry.name] = entry.value ?? null;
  }
  return map;
}

function fromStatsMap(map, candidateNames) {
  for (const name of candidateNames) {
    if (map[name] !== undefined && map[name] !== null) return map[name];
  }
  return null;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Fetch failed (${res.status}) for ${url}`);
  }
  return res.json();
}

async function fetchTeamList() {
  const json = await fetchJson(
    'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams?limit=32'
  );
  const entries = json?.sports?.[0]?.leagues?.[0]?.teams ?? [];
  return entries.map((e) => ({
    id: e.team.id,
    abbreviation: e.team.abbreviation,
    displayName: e.team.displayName,
  }));
}

async function fetchTeamPowerIndex(season, teamId) {
  const url = `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/powerindex/${teamId}`;
  return fetchJson(url);
}

function extractRating(teamMeta, raw) {
  const map = statsMap(raw);
  return {
    teamId: teamMeta.id,
    team: teamMeta.abbreviation,
    fpi: fromStatsMap(map, RATING_FIELD_CANDIDATES.fpi),
    rank: fromStatsMap(map, RATING_FIELD_CANDIDATES.rank),
    offense: fromStatsMap(map, RATING_FIELD_CANDIDATES.offense),
    defense: fromStatsMap(map, RATING_FIELD_CANDIDATES.defense),
    specialTeams: fromStatsMap(map, RATING_FIELD_CANDIDATES.specialTeams),
    trend: fromStatsMap(map, RATING_FIELD_CANDIDATES.trend),
  };
}

function extractProjection(teamMeta, raw) {
  const map = statsMap(raw);
  return {
    teamId: teamMeta.id,
    team: teamMeta.abbreviation,
    projectedWins: fromStatsMap(map, PROJECTION_FIELD_CANDIDATES.projectedWins),
    projectedLosses: fromStatsMap(map, PROJECTION_FIELD_CANDIDATES.projectedLosses),
    playoffOdds: fromStatsMap(map, PROJECTION_FIELD_CANDIDATES.playoffOdds),
    divisionOdds: fromStatsMap(map, PROJECTION_FIELD_CANDIDATES.divisionOdds),
    conferenceOdds: fromStatsMap(map, PROJECTION_FIELD_CANDIDATES.conferenceOdds),
    superBowlOdds: fromStatsMap(map, PROJECTION_FIELD_CANDIDATES.superBowlOdds),
  };
}

async function readJsonIfExists(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
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
  console.log(`Running FPI update for season ${season}...`);

  const teams = await fetchTeamList();
  console.log(`Fetched ${teams.length} teams.`);

  const rawPayloads = await Promise.all(
    teams.map((t) => fetchTeamPowerIndex(season, t.id).catch((err) => {
      console.error(`Failed to fetch team ${t.abbreviation}:`, err.message);
      return null;
    }))
  );

  const ratings = [];
  const projections = [];
  teams.forEach((teamMeta, i) => {
    const raw = rawPayloads[i];
    if (!raw) return;
    ratings.push(extractRating(teamMeta, raw));
    projections.push(extractProjection(teamMeta, raw));
  });

  const date = todayIso();

  // Current snapshots (overwritten each run)
  await writeJson(path.join(DATA_DIR, 'ratings-current.json'), { date, season, teams: ratings });
  await writeJson(path.join(DATA_DIR, 'projections-current.json'), { date, season, teams: projections });

  // Append-only archives, guarded against duplicate same-day runs
  const ratingsArchivePath = path.join(DATA_DIR, 'ratings-archive.json');
  const projectionsArchivePath = path.join(DATA_DIR, 'projections-archive.json');

  const ratingsArchive = await appendArchive(ratingsArchivePath, { date, season, teams: ratings });
  const projectionsArchive = await appendArchive(projectionsArchivePath, { date, season, teams: projections });

  await writeJson(ratingsArchivePath, ratingsArchive);
  await writeJson(projectionsArchivePath, projectionsArchive);

  console.log('Done.');
}

main().catch((err) => {
  console.error('Update failed:', err);
  process.exit(1);
});
