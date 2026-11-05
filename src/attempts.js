// Walks the event log of a game (see bmatch-gameserver/utils/gameEvents.js) and turns the moves of
// human players into scored attempts. Every open bubble, whoever opened it (bots included), updates
// what is known about the board, because everybody at the table sees it. Only human moves are
// evaluated: bot moves (incl. bots that took a leaver's seat) and every move after "debug end"
// (played by the bot logic for everybody) only update the board knowledge.

const TURN_SECONDS = 30;

const key = player => `${player.type}:${player.id}`;

// What the table knows before a pick: bubbles seen and still closed, with their images.
class Board {
    constructor(size) {
        this.size = size;
        this.seen = new Map();      // bubbleId -> {img, at: index of the open that last revealed it}
        this.matched = new Set();
        this.opens = 0;
    }

    unseenCount(except = null) {
        let count = this.size - this.matched.size - this.seen.size;
        if (except != null && !this.seen.has(except) && !this.matched.has(except)) count--;
        return count;
    }

    // Seen bubble with the same image as `bubbleId` (its mate), if any.
    knownMate(bubbleId, img) {
        for (const [id, info] of this.seen) if (id !== bubbleId && info.img === img) return id;
        return null;
    }

    knownPairs() {
        const byImg = new Map();
        const pairs = [];
        for (const [id, info] of this.seen) {
            if (byImg.has(info.img)) pairs.push([byImg.get(info.img), id]);
            else byImg.set(info.img, id);
        }
        return pairs;
    }

    // Seen bubbles whose mate is still unseen.
    singles() {
        return this.seen.size - 2 * this.knownPairs().length;
    }

    open(bubbleId, img) {
        this.seen.set(bubbleId, {img, at: this.opens++});
    }

    match(ids) {
        for (const id of ids) {
            this.seen.delete(id);
            this.matched.add(id);
        }
    }

    age(bubbleId) {
        const info = this.seen.get(bubbleId);
        return info ? this.opens - info.at : null;
    }
}

// Chance to find a pair this attempt if the second pick is played perfectly.
function firstPickChances(board, firstId) {
    const unseen = board.unseenCount();
    const singles = board.singles();
    // Opening an unknown bubble: its mate is one of the seen singles, or a 1-in-(unseen-1) guess.
    const unknown = unseen === 0 ? 0 : singles / unseen + (unseen > 1 ? (unseen - singles) / unseen / (unseen - 1) : 0);
    const best = board.knownPairs().length > 0 ? 1 : Math.max(unknown, unseen > 0 ? 1 / unseen : 0);
    let chosen;
    if (firstId == null) chosen = 0;
    else if (board.knownPairs().some(pair => pair.includes(firstId))) chosen = 1;
    else if (board.seen.has(firstId)) chosen = unseen > 0 ? 1 / unseen : 0;   // a known single: its mate is unseen
    else chosen = unknown;
    return {best, chosen};
}

// Returns {attempts, playersOf} where attempts is a list per human player (key "Player:<id>").
// includeAutoplay: also score moves played automatically after "debug end" as the player's own
// (to try the pipeline on debug games; such results are never rated).
function collectAttempts(replay, {includeAutoplay = false} = {}) {
    const humans = replay.players.filter(player => player.type === 'Player');
    const attempts = Object.fromEntries(humans.map(player => [key(player), []]));
    const board = new Board(replay.board?.length || 100);
    const pauses = [];             // [start, end] spans where the game was paused
    let pausedAt = null;
    let scoring = true;            // false after "debug end"
    const stopped = new Set();     // humans who left
    let turnStart = null;          // when the current pick could start
    let current = null;            // the attempt being played by a human, or null
    let mover = null;

    const scored = player => scoring && player?.type === 'Player' && attempts[key(player)] && !stopped.has(key(player));

    const finish = (attempt, outcome, t) => {
        attempt.outcome = outcome;
        attempt.endedAt = t;
        attempts[attempt.player].push(attempt);
    };

    for (const event of replay.events) {
        switch (event.type) {
            case 'turn':
                if (current) finish(current, 'unfinished', event.t);
                current = null;
                mover = event.player;
                turnStart = event.t;
                break;
            case 'pause':
                if (pausedAt == null) pausedAt = event.t;
                break;
            case 'resume':
                if (pausedAt != null) pauses.push([pausedAt, event.t]);
                pausedAt = null;
                break;
            case 'debug':
                if (current) finish(current, 'unfinished', event.t);
                current = null;
                scoring = includeAutoplay;
                break;
            case 'leave':
                if (current && current.player === key(event.player)) {
                    finish(current, 'left', event.t);
                    current = null;
                }
                stopped.add(key(event.player));
                break;
            case 'open': {
                const evaluate = scored(event.player);
                if (evaluate && !current) {
                    const chances = firstPickChances(board, event.bubbleId);
                    const pairs = board.knownPairs();
                    const pair = pairs.find(ids => ids.includes(event.bubbleId));
                    current = {
                        player: key(event.player),
                        startedAt: turnStart,
                        picks: [{t: event.t, start: turnStart, bubbleId: event.bubbleId}],
                        best: chances.best,
                        chosen: chances.chosen,
                        // A pair was known before the first pick: a recall chance (decided by the second pick).
                        recall: pairs.length > 0 ? {age: Math.min(...(pair ?? pairs.flat()).map(id => board.age(id))), kind: 'pair', hit: false} : null,
                    };
                } else if (evaluate && current && current.picks.length === 1) {
                    const first = current.picks[0];
                    const firstImg = board.seen.get(first.bubbleId)?.img;
                    const mate = board.knownMate(first.bubbleId, firstImg);
                    const unseen = board.unseenCount();
                    current.picks.push({t: event.t, start: first.t, bubbleId: event.bubbleId});
                    // The second pick is right if it takes the known mate, or, with no mate known,
                    // probes an unseen bubble. Anything else cannot be a pair.
                    current.secondCorrect = mate != null ? event.bubbleId === mate : !board.seen.has(event.bubbleId);
                    current.wastedProbe = mate == null && board.seen.has(event.bubbleId);
                    current.secondChance = mate != null ? 1 : (unseen > 0 ? 1 / unseen : 0);
                    // The first pick showed an image seen before: a recall chance.
                    if (mate != null && !current.recall) current.recall = {age: board.age(mate), kind: 'mate', hit: false};
                    if (current.recall) current.recall.hit = mate != null && event.bubbleId === mate;
                }
                board.open(event.bubbleId, event.bubbleImg);
                break;
            }
            case 'match':
            case 'miss':
                if (event.type === 'match') board.match(event.bubbles);
                if (current && current.player === key(event.player) && current.picks.length === 2) {
                    finish(current, event.type, event.t);
                    current = null;
                }
                // A match keeps the turn: the next pick can start now.
                turnStart = event.t;
                break;
            case 'timeout':
                if (scored(event.player)) {
                    const attempt = current ?? {
                        player: key(event.player), startedAt: turnStart, picks: [],
                        best: firstPickChances(board, null).best, chosen: 0, recall: null
                    };
                    finish(attempt, 'timeout', event.t);
                }
                current = null;
                break;
            case 'end':
                if (current) finish(current, 'unfinished', event.t);
                current = null;
                break;
            default:
                break;
        }
    }
    if (pausedAt != null) pauses.push([pausedAt, Infinity]);

    // Thinking time of each pick, without paused spans, capped by the turn timer.
    const thinking = (start, end) => {
        if (start == null || end == null) return null;
        let ms = end - start;
        for (const [from, to] of pauses) ms -= Math.max(0, Math.min(end, to) - Math.max(start, from));
        return Math.min(Math.max(ms, 0), TURN_SECONDS * 1000) / 1000;
    };
    for (const list of Object.values(attempts)) {
        for (const attempt of list) {
            attempt.thinkTimes = attempt.picks.map(pick => thinking(pick.start, pick.t));
            if (attempt.outcome === 'timeout') attempt.thinkTimes.push(TURN_SECONDS);
        }
    }
    return {attempts, humans, debugCut: !scoring};
}

module.exports = {collectAttempts, Board, firstPickChances, TURN_SECONDS, key};
