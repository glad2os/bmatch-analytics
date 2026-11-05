const {Pool} = require('pg');

// Connection settings come from the standard PG* variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE).
function connect() {
    return new Pool({max: 2});
}

const CREATE_ANALYTICS_TABLE = `
    CREATE TABLE IF NOT EXISTS game_analytics (
        -- no foreign key: game_replays is created by the gameserver and may not exist yet
        game_uuid UUID NOT NULL,
        player_id INTEGER NOT NULL,
        username VARCHAR(50),
        metrics JSONB NOT NULL,
        performance REAL,
        mmr_before INTEGER,
        mmr_delta INTEGER NOT NULL,
        rated BOOLEAN NOT NULL,
        model_version SMALLINT NOT NULL,
        computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        applied_at TIMESTAMPTZ,
        PRIMARY KEY (game_uuid, player_id)
    )`;

async function loadReplay(pool, gameUUID) {
    const {rows: [{exists}]} = await pool.query(`SELECT to_regclass('game_replays') IS NOT NULL AS exists`);
    if (!exists) return null;
    const {rows} = await pool.query(
        `SELECT game_uuid, players, board, events, is_debug, finished_at FROM game_replays WHERE game_uuid = $1`,
        [gameUUID]);
    if (!rows.length) return null;
    const row = rows[0];
    return {gameUUID: row.game_uuid, players: row.players, board: row.board, events: row.events, debug: row.is_debug, finishedAt: row.finished_at};
}

async function listReplays(pool, limit = 20) {
    const {rows: [{exists}]} = await pool.query(`SELECT to_regclass('game_replays') IS NOT NULL AS exists`);
    if (!exists) return [];
    const {rows} = await pool.query(
        `SELECT r.game_uuid, r.finished_at, r.is_debug, jsonb_array_length(r.events) AS events,
                (SELECT string_agg(p->>'username', ', ') FROM jsonb_array_elements(r.players) p WHERE p->>'type' = 'Player') AS humans,
                EXISTS (SELECT 1 FROM game_analytics a WHERE a.game_uuid = r.game_uuid) AS analysed
         FROM game_replays r ORDER BY r.finished_at DESC LIMIT $1`, [limit]);
    return rows;
}

// Stores the analysis. With apply, also adds mmr_delta to users.mmr - once per game and player:
// a row that was already applied is left untouched.
async function saveAnalysis(pool, analysis, {apply = false} = {}) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const applied = [];
        for (const player of analysis.players) {
            const {rows} = await client.query(
                `INSERT INTO game_analytics (game_uuid, player_id, username, metrics, performance, mmr_before, mmr_delta, rated, model_version)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (game_uuid, player_id) DO UPDATE SET
                     username = EXCLUDED.username, metrics = EXCLUDED.metrics, performance = EXCLUDED.performance,
                     mmr_before = EXCLUDED.mmr_before, mmr_delta = EXCLUDED.mmr_delta, rated = EXCLUDED.rated,
                     model_version = EXCLUDED.model_version, computed_at = now()
                 WHERE game_analytics.applied_at IS NULL
                 RETURNING applied_at`,
                [analysis.gameUUID, player.id, player.username, JSON.stringify({...player.metrics, mmr: player.mmr, debug: analysis.debug, autoplay: analysis.autoplay}),
                    player.mmr.performance, player.mmrBefore, player.mmr.delta, player.mmr.rated, analysis.modelVersion]);
            if (!rows.length) {
                applied.push({id: player.id, status: 'already applied, kept'});
                continue;
            }
            if (apply && player.mmr.rated) {
                await client.query(`UPDATE users SET mmr = COALESCE(mmr, 0) + $2 WHERE id = $1`, [player.id, player.mmr.delta]);
                await client.query(`UPDATE game_analytics SET applied_at = now() WHERE game_uuid = $1 AND player_id = $2`,
                    [analysis.gameUUID, player.id]);
                applied.push({id: player.id, status: `mmr ${player.mmr.delta >= 0 ? '+' : ''}${player.mmr.delta}`});
            } else {
                applied.push({id: player.id, status: 'saved'});
            }
        }
        await client.query('COMMIT');
        return applied;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {connect, CREATE_ANALYTICS_TABLE, loadReplay, listReplays, saveAnalysis};
