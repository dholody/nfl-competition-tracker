// Shared FPI-to-win-probability model. Both update-schedule.mjs and
// simulate-season.mjs import from here so the margin-to-probability curve
// (and home-field constant) can never drift out of sync between the two.

export const HOME_FIELD_ADV = 2.0; // points added to the home side's predicted margin

// Converts a predicted point margin into a win probability via a logistic
// curve: P(favorite wins) = 1 / (1 + e^(-margin / WIN_PROB_SCALE)).
// WIN_PROB_SCALE = 7 approximates the commonly-cited NFL rule of thumb that
// each point of spread is worth roughly 3-4% of win probability near a
// pick'em game, and lines up reasonably well with published spread-to-win%
// tables (e.g. -3 ~60%, -7 ~72%, -10 ~79%, -14 ~87%).
export const WIN_PROB_SCALE = 7;

// margin is from the "home" side's perspective (positive = home favored).
// Returns the home side's win probability as a 0-1 fraction.
export function marginToHomeWinProbability(margin) {
  return 1 / (1 + Math.exp(-margin / WIN_PROB_SCALE));
}
