// Fetches ESPN's FPI ratings + projections API, writes current-state and
// append-only archive JSON files into /data. Run by the weekly GitHub
// Actions workflow (or manually with: node scripts/update-fpi.mjs).
//
// IMPORTANT: the candidate field-name arrays below are best-guess discovery
// lists, same pattern as the old Apps Script version (first match wins, so
// upstream renames don't break the whole run). Run scripts/debug-fields.mjs
// once against the live API and adjust these candidate lists if ESPN's real
// field names differ.

import { promises as fs } from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('data');

const RATING_FIELD_CANDIDATES = {
  fpi: ['fpi', 'rating', 'value'],
  rank: ['rank', 'fpiRank'],
  offense: ['offensiveEfficiency', 'off', 'offense'],
  defense: ['defensiveEfficiency', 'def', 'defense'],
  specialTeams: ['specialTeamsEfficiency', 'st', 'specialTeams'],
};

const PROJECTION_FIELD_CANDIDATES = {
  projectedWins: ['projectedWins', 'winsProjection', 'wins'],
  projectedLosses: ['projectedLosses', 'lossesProjection', 'losses'],
  playoffOdds: ['playoffOdds', 'makePlayoffs'],
  divisionOdds: ['winDivision', 'divisionOdds'],
  conferenceOdds: ['winConference', 'conferenceOdds'],
  superBowlOdds: ['winSuperBowl', 'superBowlOdds'],
};

function detectSeason(date = new Date()) {
  const month = date.getUTCMonth() + 1; // 1-12
  const year = date.getUTCFullYear();
  return month >= 8 ? year : year - 1;
}

function firstMatch(source, candidates) {
  if (!source) return null;
  for (const key of candidates) {
    if (source[key] !== undefined && source[key] !== null) {
      return source[key];
    }
  }
  return null;
}

function findStat(statsArray, candidateNames) {
  if (!Array.isArray(statsArray)) return null;
  for (const name of candidateNames) {
    const found = statsArray.find(
      (s) => s?.name === name || s?.abbreviation === name || s?.shortDisplayName === name
    );
    if (found) return found.value ?? found.displayValue ?? null;
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
  const url = `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/types/2/teams/${teamId}/powerindex`;
  return fetchJson(url);
}

function extractRating(teamMeta, raw) {
  const stats = raw?.categories?.[0]?.values ?? raw?.stats ?? [];
  return {
    teamId: teamMeta.id,
    team: teamMeta.abbreviation,
    fpi: firstMatch(raw, RATING_FIELD_CANDIDATES.fpi) ?? findStat(stats, RATING_FIELD_CANDIDATES.fpi),
    rank: firstMatch(raw, RATING_FIELD_CANDIDATES.rank),
    offense: findStat(stats, RATING_FIELD_CANDIDATES.offense),
    defense: findStat(stats, RATING_FIELD_CANDIDATES.defense),
    specialTeams: findStat(stats, RATING_FIELD_CANDIDATES.specialTeams),
  };
}

function extractProjection(teamMeta, raw) {
  const stats = raw?.categories?.[0]?.values ?? raw?.stats ?? [];
  return {
    teamId: teamMeta.id,
    team: teamMeta.abbreviation,
    projectedWins: findStat(stats, PROJECTION_FIELD_CANDIDATES.projectedWins),
    projectedLosses: findStat(stats, PROJECTION_FIELD_CANDIDATES.projectedLosses),
    playoffOdds: findStat(stats, PROJECTION_FIELD_CANDIDATES.playoffOdds),
    divisionOdds: findStat(stats, PROJECTION_FIELD_CANDIDATES.divisionOdds),
    conferenceOdds: findStat(stats, PROJECTION_FIELD_CANDIDATES.conferenceOdds),
    superBowlOdds: findStat(stats, PROJECTION_FIELD_CANDIDATES.superBowlOdds),
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
