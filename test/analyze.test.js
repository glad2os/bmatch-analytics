const {test} = require('node:test');
const assert = require('node:assert/strict');
const {analyzeReplay} = require('../src/analyze');
const {Board, firstPickChances} = require('../src/attempts');
const {mmrChange, expectedPerformance} = require('../src/mmr');

// Board where bubbles 2k and 2k+1 hold image k+1.
const img = id => Math.floor(id / 2) + 1;
const HUMAN = {type: 'Player', id: 1};
const OTHER = {type: 'Player', id: 2};
const BOT = {type: 'Bot', id: 'bot-0'};

// A tiny script language for event logs: each step advances the clock by `dt` ms (default 2 s).
function game(steps, {size = 20, players = [HUMAN, BOT], debug = false, mmr = 2000} = {}) {
    let t = 1000;
    const events = [{type: 'start', players, t}];
    for (const step of steps) {
        t += step.dt ?? 2000;
        const [kind, who, a, b] = step.do;
        if (kind === 'turn') events.push({type: 'turn', player: who, t});
        else if (kind === 'pick') {
            events.push({type: 'open', player: who, bubbleId: a, bubbleImg: img(a), t});
            events.push({type: 'open', player: who, bubbleId: b, bubbleImg: img(b), t: t += step.second ?? 1000});
            events.push({type: img(a) === img(b) ? 'match' : 'miss', player: who, bubbles: [a, b], t});
        } else events.push({type: kind, player: who, t, ...(a ? a : {})});
    }
    events.push({type: 'end', reason: 'completed', t: t + 1});
    return {
        gameUUID: '00000000-0000-0000-0000-000000000001', debug,
        board: Array.from({length: size}, (_, id) => img(id)),
        players: players.map(p => ({...p, username: `u${p.id}`, mmr: p.type === 'Bot' ? 0 : mmr, left: !!p.left})),
        events,
    };
}

const turn = who => ({do: ['turn', who], dt: 10});
const pick = (who, a, b, extra = {}) => ({do: ['pick', who, a, b], ...extra});
const human = analysis => analysis.players.find(p => p.id === 1);

test('a fresh board gives a 1-in-(n-1) chance for the first attempt', () => {
    const chances = firstPickChances(new Board(100), 5);
    assert.ok(Math.abs(chances.best - 1 / 99) < 1e-12);
    assert.equal(chances.chosen, chances.best);
});

test('bots are not analysed, but what they reveal counts as known to the human', () => {
    const analysis = analyzeReplay(game([
        turn(BOT), pick(BOT, 0, 2),             // bot shows image 1 (bubble 0) and image 2 (bubble 2)
        turn(HUMAN), pick(HUMAN, 1, 0),          // human opens 1 (image 1) and takes its known mate 0
        pick(HUMAN, 3, 2),                       // and again with image 2
        pick(HUMAN, 4, 6),                       // fresh guess, miss
    ]));
    assert.deepEqual(analysis.players.map(p => p.id), [1]);
    const m = human(analysis).metrics;
    assert.equal(m.memory.score, 1);
    assert.equal(m.memory.chances, 2);
    assert.equal(m.accuracy.score, 1);          // every decision was the best available
    assert.equal(m.accuracy.matches, 2);
    assert.equal(m.accuracy.luckyMatches, 0);
    assert.equal(m.streaks.longest, 2);
    assert.equal(m.streaks.continued, 1);        // match -> match, then match -> miss
    assert.equal(m.streaks.chances, 2);
});

test('ignoring a known mate is a memory failure; probing a seen bubble is a wasted probe', () => {
    const analysis = analyzeReplay(game([
        turn(BOT), pick(BOT, 0, 2),
        turn(HUMAN), pick(HUMAN, 1, 5),          // mate of 1 (bubble 0) was known: picked an unknown one
        turn(BOT), pick(BOT, 8, 10),
        turn(HUMAN), pick(HUMAN, 12, 8),         // image 7 has no known mate; 8 is known to be image 5
    ]));                                         // (0 and 1 were a known pair by then: a second missed recall)
    const m = human(analysis).metrics;
    assert.equal(m.memory.score, 0);
    assert.equal(m.memory.chances, 2);
    assert.equal(m.accuracy.wastedProbes, 1);
    assert.equal(m.accuracy.score, 0);
});

test('a known pair on the board is a recall chance even before the first pick', () => {
    const analysis = analyzeReplay(game([
        turn(BOT), pick(BOT, 0, 2), turn(BOT), pick(BOT, 1, 4),   // 0 and 1 (image 1) both seen
        turn(HUMAN), pick(HUMAN, 6, 8),                           // ignores the pair
    ], {players: [HUMAN, BOT]}));
    const m = human(analysis).metrics;
    assert.equal(m.memory.chances, 1);
    assert.equal(m.memory.score, 0);
    assert.ok(m.accuracy.score < 0.2);
});

test('thinking time excludes pauses; a timeout costs a full turn', () => {
    const analysis = analyzeReplay(game([
        turn(HUMAN),
        {do: ['pause', HUMAN], dt: 1000}, {do: ['resume', HUMAN], dt: 60000},
        pick(HUMAN, 0, 2, {dt: 2000, second: 500}),               // 3 s of play, 60 s paused
        turn(HUMAN), {do: ['timeout', HUMAN], dt: 30000},
    ]));
    const m = human(analysis).metrics;
    assert.equal(m.speed.medianSeconds, 3);                        // of 3 s, 0.5 s and 30 s
    assert.equal(m.speed.medianSecondPickSeconds, 0.5);
    assert.equal(m.accuracy.timeouts, 1);
    assert.equal(m.speed.picks, 3);                                // 3 s, 0.5 s and the 30 s timeout
});

test('moves after "debug end" are not analysed and debug games are not rated', () => {
    const analysis = analyzeReplay(game([
        turn(HUMAN), pick(HUMAN, 0, 2),
        {do: ['debug', HUMAN], dt: 10},
        turn(HUMAN), pick(HUMAN, 4, 5), pick(HUMAN, 6, 7),
    ], {debug: true}));
    const player = human(analysis);
    assert.equal(analysis.debugCut, true);
    assert.equal(player.attempts, 1);
    assert.equal(player.mmr.rated, false);
    assert.equal(player.mmr.delta, 0);
    assert.equal(typeof player.mmr.unratedDelta, 'number');
});

test('a leaver is analysed up to leaving and a loss counts at full weight', () => {
    const leaver = {...HUMAN, left: true};
    const steps = [
        turn(BOT), pick(BOT, 0, 2),
        turn(leaver), pick(leaver, 1, 5),        // memory failure
        {do: ['leave', leaver], dt: 10},
        turn(OTHER), pick(OTHER, 1, 0), pick(OTHER, 3, 2),
    ];
    const analysis = analyzeReplay(game(steps, {players: [leaver, OTHER, BOT]}));
    const player = human(analysis);
    assert.equal(player.left, true);
    assert.equal(player.attempts, 1);
    assert.ok(player.mmr.delta < 0);
    assert.equal(player.mmr.confidence, 1);
    assert.equal(player.mmr.leftEarly, true);
    const other = analysis.players.find(p => p.id === 2);
    assert.equal(other.metrics.memory.score, 1);
});

test('MMR follows performance relative to the rating, not the result', () => {
    const strong = {memory: {score: 0.9}, accuracy: {score: 0.9}, speed: {score: 0.7}, streaks: {score: 0.6}, consistency: {score: 0.8}};
    const weak = {memory: {score: 0.2}, accuracy: {score: 0.3}, speed: {score: 0.4}, streaks: {score: 0}, consistency: {score: 0.5}};
    const at = (metrics, mmr, attempts = 12) => mmrChange({metrics, mmr, attempts, rated: true}).delta;
    assert.ok(at(strong, 2000) > 0);
    assert.ok(at(weak, 2000) < 0);
    assert.ok(at(strong, 2600) < at(strong, 2000));            // more is expected of a higher rating
    assert.ok(at(strong, 2000, 3) < at(strong, 2000));          // fewer attempts, less confidence
    assert.ok(expectedPerformance(5000) < 0.86 && expectedPerformance(-5000) > 0.14);
    // A score that could not be measured is left out, not counted as zero.
    const partial = {...strong, consistency: {score: null}, streaks: {score: null}};
    assert.ok(at(partial, 2000) > 0);
});

test('--include-autoplay scores moves after "debug end" but never rates them', () => {
    const replay = game([
        {do: ['debug', HUMAN], dt: 10},
        turn(HUMAN), pick(HUMAN, 4, 5), pick(HUMAN, 6, 7),
    ], {debug: true});
    assert.equal(human(analyzeReplay(replay)).attempts, 0);
    const analysis = analyzeReplay(replay, {includeAutoplay: true});
    assert.equal(analysis.autoplay, true);
    assert.equal(human(analysis).attempts, 2);
    assert.equal(human(analysis).mmr.rated, false);
    assert.equal(human(analysis).mmr.delta, 0);
});
