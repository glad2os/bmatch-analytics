#!/usr/bin/env node
// Manual entry point:
//   analytics list [N]                 recent replays (game_uuid, players, analysed?)
//   analytics <game_uuid>              analyse and print, nothing is written
//   analytics <game_uuid> --save       also store the result in game_analytics
//   analytics <game_uuid> --apply      store and add the MMR change to users.mmr (once per game)
//   add --json for machine-readable output; --include-autoplay scores the moves played automatically
//   after "debug end" as the player's own (to try the pipeline on debug games, never rated)
const {analyzeReplay} = require('./analyze');
const {connect, CREATE_ANALYTICS_TABLE, loadReplay, listReplays, saveAnalysis} = require('./store');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fmt = value => value == null ? '—' : String(value);
const signed = value => value > 0 ? `+${value}` : String(value);

function printReport(analysis) {
    console.log(`Game ${analysis.gameUUID}${analysis.debug ? '  [debug game: not rated]' : ''}${analysis.debugCut ? '  (moves after "debug end" skipped)' : ''}${analysis.autoplay ? '  (autoplayed moves scored as the player\'s)' : ''}`);
    if (!analysis.players.length) console.log('  no human players');
    for (const player of analysis.players) {
        const m = player.metrics;
        console.log(`\n  ${player.username} (#${player.id})${player.left ? ' [left early]' : ''}  mmr ${fmt(player.mmrBefore)}, ${player.attempts} attempts`);
        console.log(`    Memory       ${fmt(m.memory.score).padEnd(6)} recalled ${m.memory.recalled}/${m.memory.chances}, mean age ${fmt(m.memory.meanRecalledAge)} opens, longest ${fmt(m.memory.longestRecalledAge)}`);
        console.log(`    Accuracy     ${fmt(m.accuracy.score).padEnd(6)} ${m.accuracy.matches}/${m.accuracy.attempts} pairs (hit rate ${fmt(m.accuracy.hitRate)}), lucky ${m.accuracy.luckyMatches}, wasted probes ${m.accuracy.wastedProbes}, timeouts ${m.accuracy.timeouts}`);
        console.log(`    Speed        ${fmt(m.speed.score).padEnd(6)} median ${fmt(m.speed.medianSeconds)} s (1st pick ${fmt(m.speed.medianFirstPickSeconds)} s, 2nd ${fmt(m.speed.medianSecondPickSeconds)} s)`);
        console.log(`    Streaks      ${fmt(m.streaks.score).padEnd(6)} longest ${m.streaks.longest}, chains ${m.streaks.chains}, continued ${m.streaks.continued}/${m.streaks.chances}`);
        console.log(`    Consistency  ${fmt(m.consistency.score).padEnd(6)} quality by thirds ${m.consistency.thirds ? m.consistency.thirds.join(' / ') : '—'}, pace spread ${fmt(m.consistency.paceSpread)}`);
        const r = player.mmr;
        const change = r.rated ? signed(r.delta) : `not rated (would be ${signed(r.unratedDelta)})`;
        console.log(`    Performance  ${fmt(r.performance)} vs expected ${r.expected} at this mmr, confidence ${r.confidence} -> MMR ${change}${r.leftEarly ? ' (left early: full weight)' : ''}`);
    }
}

async function main(argv) {
    const args = argv.filter(arg => !arg.startsWith('--'));
    const flags = new Set(argv.filter(arg => arg.startsWith('--')));
    const gameUUID = args[0];
    if (args[0] !== 'list' && !(gameUUID && UUID.test(gameUUID))) {
        console.error('Usage: analytics <game_uuid> [--save | --apply] [--json] [--include-autoplay]  |  analytics list [N]');
        process.exitCode = 2;
        return;
    }
    const pool = connect();
    try {
        await pool.query(CREATE_ANALYTICS_TABLE);
        if (args[0] === 'list') {
            const rows = await listReplays(pool, Number(args[1]) || 20);
            if (flags.has('--json')) return console.log(JSON.stringify(rows, null, 2));
            for (const row of rows) {
                console.log(`${row.game_uuid}  ${row.finished_at.toISOString()}  ${String(row.events).padStart(4)} events  ${row.is_debug ? 'debug ' : '      '}${row.analysed ? 'analysed ' : '         '}${row.humans ?? ''}`);
            }
            return;
        }
        const replay = await loadReplay(pool, gameUUID);
        if (!replay) {
            console.error(`No replay for game ${gameUUID}`);
            process.exitCode = 1;
            return;
        }
        const analysis = analyzeReplay(replay, {includeAutoplay: flags.has('--include-autoplay')});
        if (flags.has('--json')) console.log(JSON.stringify(analysis, null, 2));
        else printReport(analysis);
        if (flags.has('--save') || flags.has('--apply')) {
            const result = await saveAnalysis(pool, analysis, {apply: flags.has('--apply')});
            if (!flags.has('--json')) console.log(`\nStored: ${result.map(r => `#${r.id} ${r.status}`).join(', ') || 'nothing'}`);
        }
    } finally {
        await pool.end();
    }
}

main(process.argv.slice(2)).catch(error => {
    // A refused connection is an AggregateError without a message.
    console.error(error.message || error.code || String(error));
    process.exitCode = 1;
});
