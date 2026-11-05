// MMR change proposed for a game. It depends on how the player played, not on a fixed +/- for a win
// or a loss: the game's performance P (weighted metric scores) is compared with the performance
// expected at the player's current rating, E(mmr). Playing above your level gains rating, below
// loses it; the size grows with the number of attempts actually played (confidence).
//
// No population data exists yet, so the constants below are a first guess. They are versioned:
// every stored result records MODEL_VERSION and all raw scores, so ratings can be recalibrated.

const MODEL_VERSION = 1;

const WEIGHTS = {memory: 0.30, accuracy: 0.30, speed: 0.15, streaks: 0.10, consistency: 0.15};
const BASE_MMR = 2000;            // rating of a new account
const EXPECTED_AT_BASE = 0.5;     // expected P of a new account
const EXPECTED_SPREAD = 0.35;     // E ranges over 0.5 +/- 0.35
const MMR_SCALE = 600;            // rating difference that moves E by ~76% of the spread
const K = 40;                     // largest change of one full-confidence game is about K * 0.85
const FULL_CONFIDENCE_ATTEMPTS = 12;

// Weighted mean of the scores that could be measured; weights of missing ones are spread over the rest.
function performance(metrics) {
    let total = 0, weight = 0;
    const used = {};
    for (const [name, w] of Object.entries(WEIGHTS)) {
        const score = metrics[name]?.score;
        if (score == null) continue;
        total += w * score;
        weight += w;
        used[name] = w;
    }
    return weight ? {value: total / weight, weights: used} : {value: null, weights: used};
}

function expectedPerformance(mmr) {
    return EXPECTED_AT_BASE + EXPECTED_SPREAD * Math.tanh(((mmr ?? BASE_MMR) - BASE_MMR) / MMR_SCALE);
}

// rated=false: the delta is still computed for information but should not be applied.
function mmrChange({metrics, mmr, attempts, rated}) {
    const perf = performance(metrics);
    const expected = expectedPerformance(mmr);
    const confidence = Math.min(1, attempts / FULL_CONFIDENCE_ATTEMPTS);
    const delta = perf.value == null ? 0 : Math.round(K * (perf.value - expected) * confidence);
    return {
        performance: perf.value == null ? null : Math.round(perf.value * 1000) / 1000,
        expected: Math.round(expected * 1000) / 1000,
        confidence: Math.round(confidence * 1000) / 1000,
        weights: perf.weights,
        delta: rated ? delta : 0,
        unratedDelta: rated ? null : delta,
        rated,
    };
}

module.exports = {mmrChange, performance, expectedPerformance, MODEL_VERSION, WEIGHTS, K};
