// Run manually (locally or via a workflow_dispatch step) to inspect ESPN's
// actual field names before trusting the discovery-matching candidate lists
// in update-fpi.mjs. Equivalent to the old Apps Script debugListStats().
//
// Usage: node scripts/debug-fields.mjs

const YEAR = detectSeason();

function detectSeason(date = new Date()) {
  const month = date.getUTCMonth() + 1;
  const year = date.getUTCFullYear();
  return month >= 8 ? year : year - 1;
}

async function main() {
  console.log(`Season: ${YEAR}`);

  const teamsRes = await fetch(
    'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams?limit=32'
  );
  const teamsJson = await teamsRes.json();
  console.log('--- Team list response shape ---');
  console.log(JSON.stringify(teamsJson, null, 2).slice(0, 2000));

  const powerIndexRes = await fetch(
    `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${YEAR}/powerindex`
  );
  const powerIndexJson = await powerIndexRes.json();
  console.log('--- Powerindex top-level response shape ---');
  console.log(JSON.stringify(powerIndexJson, null, 2).slice(0, 2000));

  // If the top-level response contains $ref links per team, fetch the first
  // one fully so you can see the real field names before writing candidate
  // arrays in update-fpi.mjs.
  const firstRef = powerIndexJson?.items?.[0]?.$ref;
  if (firstRef) {
    const firstTeamRes = await fetch(firstRef);
    const firstTeamJson = await firstTeamRes.json();
    console.log('--- First team full payload ---');
    console.log(JSON.stringify(firstTeamJson, null, 2));
  }
}

main().catch((err) => {
  console.error('Debug run failed:', err);
  process.exit(1);
});
