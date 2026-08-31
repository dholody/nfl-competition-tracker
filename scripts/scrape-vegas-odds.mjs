#!/usr/bin/env node
/**
 * scrape-vegas-odds.mjs
 * ---------------------------------------------------------------
 * Fetches NFL spread/total/moneyline odds from VegasInsider and writes
 * data/odds-current.json in the same style as the other data/*.json
 * files in this repo (ratings-current.json, projections-current.json, etc).
 *
 * WHY THIS EXISTS
 * The dashboard's "Jerry" columns (Line, O/U, FPI vs Moneyline, Projected
 * Score) are designed to read this file from raw.githubusercontent.com,
 * exactly like the ESPN-derived files. VegasInsider's odds page renders
 * server-side (unlike ESPN's FPI page), so a plain fetch + HTML parse
 * works here without a headless browser — but it can't be fetched
 * client-side from the dashboard itself due to CORS, so this needs to
 * run server-side (GitHub Action) and commit the JSON, same pattern as
 * everything else in this repo.
 *
 * IMPORTANT — READ BEFORE FIRST RUN
 * The parsing logic below is built from the page's *rendered structure*
 * (row order, repeated game blocks, which column holds what), not from
 * inspecting VegasInsider's actual HTML class names/IDs — I didn't have
 * access to raw HTML while writing this, only a text-rendered view.
 * Run once with `--debug` first:
 *
 *     node scrape-vegas-odds.mjs --week 1 --debug
 *
 * This prints how many tables/game-blocks were found and a sample parse
 * before writing anything, so you can sanity-check it against the site.
 * If VegasInsider's markup doesn't match the assumptions documented
 * inline below, the CSS selectors in `parseOddsTables()` are the only
 * thing that should need adjusting — the JSON schema and the rest of
 * the pipeline (team-name mapping, output format) should hold either way.
 *
 * USAGE
 *   npm install cheerio node-fetch   (if not already available)
 *   node scrape-vegas-odds.mjs --week 1
 *   node scrape-vegas-odds.mjs --week 1 --debug
 *   node scrape-vegas-odds.mjs --week 1 --out data/odds-current.json
 *
 * In GitHub Actions, run this alongside the existing FPI update step,
 * passing the current NFL week (you likely already compute this for the
 * FPI scrape — reuse that value here rather than hardcoding).
 * ---------------------------------------------------------------
 */

import * as cheerio from 'cheerio';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// ---- CLI args -----------------------------------------------------------
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const WEEK = Number(getArg('week', null));
const DEBUG = !!getArg('debug', false);
const OUT_PATH = getArg('out', 'data/odds-current.json');

if (!WEEK) {
  console.error('Usage: node scrape-vegas-odds.mjs --week <N> [--debug] [--out path]');
  process.exit(1);
}

const URL = 'https://www.vegasinsider.com/nfl/odds/las-vegas/';

// ---- Team name -> abbreviation map --------------------------------------
// VegasInsider displays short team nicknames ("Patriots", "49ers"), not
// abbreviations. Mapped against the same 32 teams used elsewhere in this repo.
const NAME_TO_ABBR = {
  'Cardinals':'ARI','Falcons':'ATL','Ravens':'BAL','Bills':'BUF','Panthers':'CAR',
  'Bears':'CHI','Bengals':'CIN','Browns':'CLE','Cowboys':'DAL','Broncos':'DEN',
  'Lions':'DET','Packers':'GB','Texans':'HOU','Colts':'IND','Jaguars':'JAX',
  'Chiefs':'KC','Chargers':'LAC','Rams':'LAR','Raiders':'LV','Dolphins':'MIA',
  'Vikings':'MIN','Patriots':'NE','Saints':'NO','Giants':'NYG','Jets':'NYJ',
  'Eagles':'PHI','Steelers':'PIT','49ers':'SF','Seahawks':'SEA','Buccaneers':'TB',
  'Titans':'TEN','Commanders':'WSH'
};
function nameToAbbr(name) {
  const clean = name.trim();
  if (NAME_TO_ABBR[clean]) return NAME_TO_ABBR[clean];
  // fallback: partial match in case of trailing text/whitespace quirks
  const hit = Object.keys(NAME_TO_ABBR).find(n => clean.includes(n));
  return hit ? NAME_TO_ABBR[hit] : null;
}

// ---- Odds string parsing --------------------------------------------------
// Consensus spread cell looks like "+3.5   -105" or "-7   -110"
function parseSpreadCell(text) {
  const m = text.replace(/\s+/g, ' ').trim().match(/^([+-]?\d+(\.\d+)?)\s+(even|[+-]\d+)$/i);
  if (!m) return null;
  return Number(m[1]);
}
// Consensus total cell looks like "o44.5   -105" or "u48.5   -110"
function parseTotalCell(text) {
  const m = text.replace(/\s+/g, ' ').trim().match(/^[ou](\d+(\.\d+)?)\s+/i);
  return m ? Number(m[1]) : null;
}
// Moneyline cell is a plain American odds number, e.g. "-165" or "+140"
function parseMoneylineCell(text) {
  const m = text.replace(/\s+/g, ' ').trim().match(/^([+-]\d+)/);
  return m ? Number(m[1]) : null;
}

// ---- Table parsing --------------------------------------------------------
/**
 * Assumptions (see header comment — verify with --debug on first run):
 *  - The page contains three repeated table sections in document order:
 *    Spread, Total, Moneyline (matching the tab pills visible on the page).
 *  - Within each table, games are represented as two consecutive team rows
 *    (AWAY team row, then HOME team row) followed by a "Matchup" link row.
 *  - The rightmost/"Consensus" column holds the value to use.
 *  - Team name appears as visible link text within the row (e.g. "Patriots").
 */
function parseOddsTables(html) {
  const $ = cheerio.load(html);
  const tables = $('table').toArray();

  if (DEBUG) console.log(`[debug] found ${tables.length} <table> elements on the page`);

  // Group tables into three buckets by heuristic order: spread, total, moneyline.
  // If VegasInsider's real markup differs, adjust this selection logic —
  // e.g. by matching a nearby heading/tab element instead of raw order.
  const [spreadTable, totalTable, mlTable] = tables;

  const games = []; // keyed by "AWAY@HOME"
  function ensureGame(away, home) {
    const key = `${away}@${home}`;
    let g = games.find(x => x.key === key);
    if (!g) {
      g = { key, week: WEEK, home, away, spreadHome:null, spreadAway:null, total:null, mlHome:null, mlAway:null };
      games.push(g);
    }
    return g;
  }

  function teamRows(table) {
    if (!table) return [];
    return $(table).find('tr').toArray().filter(tr => {
      const t = $(tr).text();
      return NAME_TO_ABBR && Object.keys(NAME_TO_ABBR).some(n => t.includes(n));
    });
  }

  // --- Spread table ---
  const spreadRows = teamRows(spreadTable);
  for (let i = 0; i < spreadRows.length - 1; i += 2) {
    const awayRow = spreadRows[i], homeRow = spreadRows[i + 1];
    const awayName = $(awayRow).text(), homeName = $(homeRow).text();
    const away = nameToAbbr(awayName), home = nameToAbbr(homeName);
    if (!away || !home) { if (DEBUG) console.log('[debug] spread row team match failed:', awayName.slice(0,40), homeName.slice(0,40)); continue; }
    const awayConsensus = $(awayRow).find('td').last().text();
    const homeConsensus = $(homeRow).find('td').last().text();
    const g = ensureGame(away, home);
    g.spreadAway = parseSpreadCell(awayConsensus);
    g.spreadHome = parseSpreadCell(homeConsensus);
  }

  // --- Total table ---
  const totalRows = teamRows(totalTable);
  for (let i = 0; i < totalRows.length - 1; i += 2) {
    const awayRow = totalRows[i], homeRow = totalRows[i + 1];
    const away = nameToAbbr($(awayRow).text()), home = nameToAbbr($(homeRow).text());
    if (!away || !home) continue;
    const consensus = $(homeRow).find('td').last().text(); // total is shared; either row's consensus works
    const g = ensureGame(away, home);
    g.total = parseTotalCell(consensus) ?? g.total;
  }

  // --- Moneyline table ---
  const mlRows = teamRows(mlTable);
  for (let i = 0; i < mlRows.length - 1; i += 2) {
    const awayRow = mlRows[i], homeRow = mlRows[i + 1];
    const away = nameToAbbr($(awayRow).text()), home = nameToAbbr($(homeRow).text());
    if (!away || !home) continue;
    const g = ensureGame(away, home);
    g.mlAway = parseMoneylineCell($(awayRow).find('td').last().text());
    g.mlHome = parseMoneylineCell($(homeRow).find('td').last().text());
  }

  return games.map(({ key, ...g }) => g);
}

// ---- Main -----------------------------------------------------------------
async function main() {
  const res = await fetch(URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; nfl-competition-tracker/1.0)' }
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const html = await res.text();

  const games = parseOddsTables(html);

  if (DEBUG) {
    console.log(`[debug] parsed ${games.length} games:`);
    console.table(games);
  }

  const out = {
    date: new Date().toISOString().slice(0, 10),
    week: WEEK,
    games
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${games.length} games to ${OUT_PATH}`);
}

main().catch(err => {
  console.error('Scrape failed:', err);
  process.exit(1);
});
