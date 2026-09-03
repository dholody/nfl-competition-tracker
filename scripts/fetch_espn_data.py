# scripts/fetch_espn_data.py
import json
import math
import requests
from scipy.stats import norm
from simulate_playoffs import attach_playoff_leverage

# Normalize ESPN team abbreviations to match NFL_STRUCTURE
ESPN_ABBR_MAP = {
    'WSH': 'WAS',
    'LAR': 'LAR',
    'LAC': 'LAC'
}

def get_fpi_win_probability(home_fpi, away_fpi, hfa=2.0, sigma=13.5):
    """
    Computes win probability from FPI margin: N(home_fpi - away_fpi + hfa, sigma)
    Matches the normal distribution approximation already used on your site.
    """
    expected_margin = (home_fpi - away_fpi) + hfa
    return float(norm.cdf(expected_margin / sigma))

def fetch_espn_data(season=2026):
    print("Fetching ESPN Scoreboard & Schedule...")
    scoreboard_url = f"https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
    sb_res = requests.get(scoreboard_url).json()

    # Identify current NFL regular season week
    current_week = sb_res.get('week', {}).get('number', 1)
    
    # 1. Fetch live FPI ratings
    fpi_url = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/{}/types/2/groups/9/statistics"
    # Alternatively use your existing FPI ratings dict:
    fpi_ratings = {} # { 'KC': 7.2, 'SF': 6.5, ... }

    # 2. Build games roster for full season
    games = []
    for week_num in range(1, 19):
        week_url = f"https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week={week_num}"
        events = requests.get(week_url).json().get('events', [])

        for ev in events:
            comp = ev['competitions'][0]
            home_team = comp['competitors'][0] if comp['competitors'][0]['homeAway'] == 'home' else comp['competitors'][1]
            away_team = comp['competitors'][1] if comp['competitors'][0]['homeAway'] == 'home' else comp['competitors'][0]

            h_abbr = ESPN_ABBR_MAP.get(home_team['team']['abbreviation'], home_team['team']['abbreviation'])
            a_abbr = ESPN_ABBR_MAP.get(away_team['team']['abbreviation'], away_team['team']['abbreviation'])

            status = comp['status']['type']['completed']
            home_win = None
            if status:
                h_score = int(home_team.get('score', 0))
                a_score = int(away_team.get('score', 0))
                home_win = h_score > a_score

            # Probability from FPI margin model if game is in the future
            h_fpi = fpi_ratings.get(h_abbr, 0.0)
            a_fpi = fpi_ratings.get(a_abbr, 0.0)
            h_prob = get_fpi_win_probability(h_fpi, a_fpi)

            games.append({
                'id': ev['id'],
                'week': week_num,
                'home': h_abbr,
                'away': a_abbr,
                'home_prob': h_prob,
                'is_final': status,
                'home_win': home_win
            })

    # 3. RUN MONTE CARLO INGESTION
    games = attach_playoff_leverage(games, target_week=current_week, n_sims=10000)

    # 4. Save combined payload for frontend
    with open('data/season_data.json', 'w') as f:
        json.dump({
            'current_week': current_week,
            'fpi_ratings': fpi_ratings,
            'games': games
        }, f, indent=2)

    print("Data refreshed and season_data.json generated successfully.")

if __name__ == '__main__':
    fetch_espn_data()
