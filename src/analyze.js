const {collectAttempts, key} = require('./attempts');
const {playerMetrics} = require('./metrics');
const {mmrChange, MODEL_VERSION} = require('./mmr');

// replay: a row of game_replays ({gameUUID, players, board, events, debug}).
// Returns the analysis of every human player; bots are not analysed.
function analyzeReplay(replay, {includeAutoplay = false} = {}) {
    const {attempts, humans, debugCut} = collectAttempts(replay, {includeAutoplay});
    const players = humans.map(player => {
        const own = attempts[key(player)];
        const metrics = playerMetrics(own);
        const played = metrics.accuracy.attempts + metrics.accuracy.timeouts;
        const left = !!player.left;
        // Debug games are not rated; nor is someone who never made a move.
        const rated = !replay.debug && played > 0;
        let mmr = mmrChange({metrics, mmr: player.mmr, attempts: played, rated});
        // Leaving early must not shrink a loss: a leaver's negative change counts at full confidence.
        if (left && rated && mmr.delta < 0) mmr = {...mmrChange({metrics, mmr: player.mmr, attempts: Infinity, rated}), leftEarly: true};
        return {
            id: player.id,
            username: player.username,
            mmrBefore: player.mmr ?? null,
            left,
            attempts: played,
            metrics,
            mmr,
        };
    });
    return {
        gameUUID: replay.gameUUID,
        modelVersion: MODEL_VERSION,
        debug: !!replay.debug,
        // Moves played by the bot logic after "debug end" were scored as the player's (--include-autoplay).
        autoplay: includeAutoplay && replay.events.some(event => event.type === 'debug'),
        // Moves after "debug end" were played by the bot logic and are not analysed.
        debugCut,
        players,
    };
}

module.exports = {analyzeReplay};
