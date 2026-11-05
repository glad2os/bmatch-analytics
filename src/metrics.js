// Per-player performance metrics of one game, each a score in [0, 1] (null when the game gave no
// chance to measure it). Definitions are in README.md; they are normalised per opportunity, so a
// game with three bots that reveal a lot of the board is comparable with a game of two people.
const {TURN_SECONDS} = require('./attempts');

const FAST_SECONDS = 0.8;          // a pick this fast scores 1 for speed
const MIN_ATTEMPTS_FOR_CONSISTENCY = 6;

const round = (value, digits = 3) => value == null ? null : Math.round(value * 10 ** digits) / 10 ** digits;
const clamp01 = value => Math.min(1, Math.max(0, value));
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// How good the decisions of an attempt were, whatever the luck: the chance of a pair the player's
// picks gave, divided by the best chance available in that position. Attempts that were cut by a
// leave or by "debug end" are not judged.
function quality(attempt) {
    if (attempt.outcome === 'left' || attempt.outcome === 'unfinished') return null;
    if (!(attempt.best > 0)) return null;
    if (attempt.picks.length < 2) return 0;                    // ran out of time
    return clamp01(attempt.chosen / attempt.best) * (attempt.secondCorrect ? 1 : 0);
}

function memory(attempts) {
    const recalls = attempts.map(attempt => attempt.recall).filter(Boolean);
    const hits = recalls.filter(recall => recall.hit);
    return {
        score: recalls.length ? round(hits.length / recalls.length) : null,
        chances: recalls.length,
        recalled: hits.length,
        // Opens between seeing a bubble and using it; larger = remembered for longer.
        meanRecalledAge: round(mean(hits.map(recall => recall.age)), 1),
        longestRecalledAge: hits.length ? Math.max(...hits.map(recall => recall.age)) : null,
    };
}

function accuracy(attempts) {
    const judged = attempts.map(quality).filter(value => value != null);
    const finished = attempts.filter(attempt => attempt.outcome === 'match' || attempt.outcome === 'miss');
    const matches = finished.filter(attempt => attempt.outcome === 'match');
    return {
        score: judged.length ? round(mean(judged)) : null,
        attempts: finished.length,
        matches: matches.length,
        hitRate: finished.length ? round(matches.length / finished.length) : null,
        // Pairs found by an unforced guess rather than from memory.
        luckyMatches: matches.filter(attempt => !attempt.recall?.hit).length,
        wastedProbes: attempts.filter(attempt => attempt.wastedProbe).length,
        timeouts: attempts.filter(attempt => attempt.outcome === 'timeout').length,
    };
}

function speed(attempts) {
    const times = attempts.flatMap(attempt => attempt.thinkTimes).filter(value => value != null);
    const firstPicks = attempts.map(attempt => attempt.thinkTimes[0]).filter(value => value != null);
    const secondPicks = attempts.map(attempt => attempt.thinkTimes[1]).filter(value => value != null);
    const typical = median(times);
    // Logarithmic: going from 1 s to 2 s costs as much as from 8 s to 16 s.
    const score = typical == null ? null
        : clamp01(1 - Math.log(Math.max(typical, FAST_SECONDS) / FAST_SECONDS) / Math.log(TURN_SECONDS / FAST_SECONDS));
    return {
        score: round(score),
        medianSeconds: round(typical, 2),
        medianFirstPickSeconds: round(median(firstPicks), 2),
        medianSecondPickSeconds: round(median(secondPicks), 2),
        picks: times.length,
    };
}

function streaks(attempts) {
    const finished = attempts.filter(attempt => ['match', 'miss', 'timeout'].includes(attempt.outcome));
    let longest = 0, run = 0, chains = 0, continued = 0, chances = 0;
    for (let i = 0; i < finished.length; i++) {
        const matched = finished[i].outcome === 'match';
        run = matched ? run + 1 : 0;
        longest = Math.max(longest, run);
        if (run === 2) chains++;
        // A pair keeps the turn: did the next attempt find one too?
        if (matched && i + 1 < finished.length) {
            chances++;
            if (finished[i + 1].outcome === 'match') continued++;
        }
    }
    return {
        score: chances ? round(continued / chances) : null,
        longest,
        chains,
        continued,
        chances,
    };
}

// Steadiness over the game: decision quality should not swing between the first, middle and last
// third of the player's attempts, and the pace should be even (median absolute deviation of thinking
// time relative to its median).
function consistency(attempts) {
    const judged = attempts.map(quality).filter(value => value != null);
    const times = attempts.flatMap(attempt => attempt.thinkTimes).filter(value => value != null);
    if (judged.length < MIN_ATTEMPTS_FOR_CONSISTENCY) {
        return {score: null, qualitySpread: null, paceSpread: null, attempts: judged.length};
    }
    const third = judged.length / 3;
    const blocks = [0, 1, 2].map(i => mean(judged.slice(Math.round(i * third), Math.round((i + 1) * third))));
    const qualitySpread = Math.max(...blocks) - Math.min(...blocks);
    const typical = median(times);
    const paceSpread = typical > 0 ? median(times.map(time => Math.abs(time - typical))) / typical : 0;
    return {
        score: round((clamp01(1 - qualitySpread) + clamp01(1 - paceSpread)) / 2),
        qualitySpread: round(qualitySpread),
        paceSpread: round(paceSpread),
        thirds: blocks.map(value => round(value)),
        attempts: judged.length,
    };
}

function playerMetrics(attempts) {
    return {
        memory: memory(attempts),
        accuracy: accuracy(attempts),
        speed: speed(attempts),
        streaks: streaks(attempts),
        consistency: consistency(attempts),
    };
}

module.exports = {playerMetrics, quality, median};
