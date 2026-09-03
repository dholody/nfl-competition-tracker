import json
import sys
import numpy as np
import pandas as pd

# NFL Conference and Division Alignment
NFL_STRUCTURE = {
    'AFC': {
        'AFC East': ['BUF', 'MIA', 'NE', 'NYJ'],
        'AFC North': ['BAL', 'CIN', 'CLE', 'PIT'],
        'AFC South': ['HOU', 'IND', 'JAX', 'TEN'],
        'AFC West': ['DEN', 'KC', 'LV', 'LAC']
    },
    'NFC': {
        'NFC East': ['DAL', 'NYG', 'PHI', 'WAS'],
        'NFC North': ['CHI', 'DET', 'GB', 'MIN'],
        'NFC South': ['ATL', 'CAR', 'NO', 'TB'],
        'NFC West': ['ARI', 'LAR', 'SF', 'SEA']
    }
}

ALL_TEAMS = [team for conf in NFL_STRUCTURE.values() for div in conf.values() for team in div]
TEAM_TO_CONF = {team: conf for conf, divs in NFL_STRUCTURE.items() for div, teams in divs.items() for team in teams}
TEAM_TO_DIV = {team: div for conf, divs in NFL_STRUCTURE.items() for div, teams in divs.items() for team in teams}

def load_schedule_and_odds(filepath='data/schedule_odds.json'):
    """
    Expects a JSON array of games:
    [
      {
        "id": "401671800",
        "week": 4,
        "home": "KC",
        "away": "LAC",
        "home_prob": 0.65,
        "is_final": false,
        "home_win": null
      }
    ]
    """
    with open(filepath, 'r') as f:
        return json.load(f)

def run_season_monte_carlo(games, n_sims=10000, fixed_game_id=None, fixed_home_win=None):
    """
    Vectorized Monte Carlo simulation across all 32 teams.
    """
    n_teams = len(ALL_TEAMS)
    team_idx = {team: i for i, team in enumerate(ALL_TEAMS)}
    
    # Track wins: [Simulations x 32 Teams]
    total_wins = np.zeros((n_sims, n_teams), dtype=np.float32)
    div_wins = np.zeros((n_sims, n_teams), dtype=np.float32)
    conf_wins = np.zeros((n_sims, n_teams), dtype=np.float32)
    
    for g in games:
        h_idx = team_idx[g['home']]
        a_idx = team_idx[g['away']]
        is_div = (TEAM_TO_DIV[g['home']] == TEAM_TO_DIV[g['away']])
        is_conf = (TEAM_TO_CONF[g['home']] == TEAM_TO_CONF[g['away']])
        
        if g.get('is_final', False):
            # Game already played
            h_wins = 1.0 if g['home_win'] else 0.0
            total_wins[:, h_idx] += h_wins
            total_wins[:, a_idx] += (1.0 - h_wins)
            if is_div:
                div_wins[:, h_idx] += h_wins
                div_wins[:, a_idx] += (1.0 - h_wins)
            if is_conf:
                conf_wins[:, h_idx] += h_wins
                conf_wins[:, a_idx] += (1.0 - h_wins)
        elif g['id'] == fixed_game_id:
            # Clamped counterfactual condition
            h_wins = 1.0 if fixed_home_win else 0.0
            total_wins[:, h_idx] += h_wins
            total_wins[:, a_idx] += (1.0 - h_wins)
            if is_div:
                div_wins[:, h_idx] += h_wins
                div_wins[:, a_idx] += (1.0 - h_wins)
            if is_conf:
                conf_wins[:, h_idx] += h_wins
                conf_wins[:, a_idx] += (1.0 - h_wins)
        else:
            # Simulate remaining games
            rand_draws = np.random.rand(n_sims)
            h_won = (rand_draws < g['home_prob']).astype(np.float32)
            total_wins[:, h_idx] += h_won
            total_wins[:, a_idx] += (1.0 - h_won)
            if is_div:
                div_wins[:, h_idx] += h_won
                div_wins[:, a_idx] += (1.0 - h_won)
            if is_conf:
                conf_wins[:, h_idx] += h_won
                conf_wins[:, a_idx] += (1.0 - h_won)

    # Composite tiebreaker score: Wins (primary), Div Wins, Conf Wins, Random Noise
    # This evaluates Division and Conf records before falling back to coin tosses
    tiebreak_score = (total_wins * 10000.0) + (div_wins * 100.0) + (conf_wins * 1.0) + np.random.uniform(0, 0.01, size=total_wins.shape)

    playoff_qualifiers = np.zeros((n_sims, n_teams), dtype=bool)

    for conf_name, divisions in NFL_STRUCTURE.items():
        div_winner_indices = []
        
        # 1. Determine Division Winners
        for div_name, div_teams in divisions.items():
            d_indices = [team_idx[t] for t in div_teams]
            d_scores = tiebreak_score[:, d_indices]
            best_in_div = np.argmax(d_scores, axis=1)
            for sim in range(n_sims):
                winner_idx = d_indices[best_in_div[sim]]
                playoff_qualifiers[sim, winner_idx] = True
                div_winner_indices.append((sim, winner_idx))

        # 2. Determine Wild Cards (Top 3 remaining non-division winners)
        conf_team_indices = [team_idx[t] for div in divisions.values() for t in div]
        for sim in range(n_sims):
            pool = [idx for idx in conf_team_indices if not playoff_qualifiers[sim, idx]]
            # Sort remaining contenders by composite score
            pool_scores = [tiebreak_score[sim, idx] for idx in pool]
            top_3 = [pool[i] for i in np.argsort(pool_scores)[-3:]]
            for wc_idx in top_3:
                playoff_qualifiers[sim, wc_idx] = True

    # Return playoff rate for all teams [0.0 to 1.0]
    return np.mean(playoff_qualifiers, axis=0)

def compute_week_leverage(games, current_week, n_sims=10000):
    """
    Computes exact conditional odds for all matchups in the target week.
    """
    week_games = [g for g in games if g.get('week') == current_week]
    results = []

    print(f"Simulating {len(week_games)} matchups for Week {current_week} ({n_sims} runs each)...")

    for g in week_games:
        # Scenario 1: Home Team Wins
        playoff_probs_if_h_wins = run_season_monte_carlo(games, n_sims, fixed_game_id=g['id'], fixed_home_win=True)
        # Scenario 2: Home Team Loses (Away Wins)
        playoff_probs_if_h_loses = run_season_monte_carlo(games, n_sims, fixed_game_id=g['id'], fixed_home_win=False)

        h_idx = ALL_TEAMS.index(g['home'])
        a_idx = ALL_TEAMS.index(g['away'])

        h_win_odds = float(playoff_probs_if_h_wins[h_idx])
        h_loss_odds = float(playoff_probs_if_h_loses[h_idx])
        a_win_odds = float(playoff_probs_if_h_loses[a_idx])
        a_loss_odds = float(playoff_probs_if_h_wins[a_idx])

        h_swing = h_win_odds - h_loss_odds
        a_swing = a_win_odds - a_loss_odds
        total_leverage = h_swing + a_swing

        results.append({
            "game_id": g['id'],
            "week": current_week,
            "home": g['home'],
            "away": g['away'],
            "home_prob": g.get('home_prob'),
            "home_playoff_if_win": round(h_win_odds * 100, 1),
            "home_playoff_if_loss": round(h_loss_odds * 100, 1),
            "home_swing": round(h_swing * 100, 1),
            "away_playoff_if_win": round(a_win_odds * 100, 1),
            "away_playoff_if_loss": round(a_loss_odds * 100, 1),
            "away_swing": round(a_swing * 100, 1),
            "total_leverage": round(total_leverage * 100, 1)
        })

    return results

if __name__ == '__main__':
    schedule_path = 'data/schedule.json'
    output_path = 'data/playoff_leverage.json'
    target_week = int(sys.argv[1]) if len(sys.argv) > 1 else 1

    games = load_schedule_and_odds(schedule_path)
    leverage_data = compute_week_leverage(games, current_week=target_week, n_sims=10000)

    with open(output_path, 'w') as f:
        json.dump(leverage_data, f, indent=2)
    print(f"Leverage data successfully written to {output_path}")
