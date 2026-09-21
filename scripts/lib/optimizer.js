'use strict';

const { MARKET_FEE, CONFIDENCE_REFERENCE_COUNT, loadBanditState } = require('./price_cache');

function estimateItem(item, body, capitalRemaining) {
  const lowest = Number(body?.lowest_price);
  const sellEstimate = Number(body?.p50_price || body?.average_price || body?.lowest_price);
  const totalCount = Number(body?.total_count || 0);
  if (!Number.isFinite(lowest) || lowest <= 0 || !Number.isFinite(sellEstimate) || sellEstimate <= 0) return null;

  const marketConfidence = Math.min(1, totalCount / CONFIDENCE_REFERENCE_COUNT);
  const baseMargin = sellEstimate * (1 - MARKET_FEE) - lowest;
  const outcomes = loadBanditState()[String(item).toLowerCase()];
  let netMargin = baseMargin;
  let sellProbability = 0.5 + 0.4 * marketConfidence;
  if (outcomes?.n_outcomes > 0) {
    const weight = Math.min(1, outcomes.n_outcomes / 5);
    sellProbability = (1 - weight) * sellProbability + weight * (outcomes.n_sold / outcomes.n_outcomes);
    if (outcomes.n_sold > 0 && outcomes.margin_sum) {
      netMargin = (1 - weight) * netMargin + weight * (outcomes.margin_sum / outcomes.n_sold);
    }
  }

  const roi = netMargin / lowest;
  return {
    item, buy_cost: lowest, sell_estimate: sellEstimate,
    net_margin: Number(netMargin.toFixed(2)), roi: Number(roi.toFixed(4)),
    total_count: totalCount,
    market_confidence: Number(marketConfidence.toFixed(2)),
    sell_probability: Number(sellProbability.toFixed(2)),
    roll_variance_warning: sellEstimate > lowest * 3 && totalCount < 30,
    affordable: lowest <= capitalRemaining,
  };
}

function optimizeSlots(estimates, capital, slots) {
  const scored = estimates
    .filter((estimate) => estimate.affordable)
    .map((estimate) => {
      let value = estimate.net_margin * estimate.sell_probability;
      if (estimate.roll_variance_warning) value *= 0.3;
      return { value, estimate };
    })
    .sort((a, b) => b.value - a.value);

  const picks = [];
  let remaining = capital;
  for (const { value, estimate } of scored) {
    if (picks.length >= slots) break;
    if (estimate.buy_cost > remaining) continue;
    picks.push({ ...estimate, sampled_expected_value: Number(value.toFixed(2)) });
    remaining -= estimate.buy_cost;
  }
  return {
    capital, slots, picks,
    capital_spent: Number((capital - remaining).toFixed(2)),
    capital_remaining: Number(remaining.toFixed(2)),
    slots_filled: picks.length,
  };
}

module.exports = { estimateItem, optimizeSlots };
