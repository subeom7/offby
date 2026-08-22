// 리더보드 쿼리.
//
// 쿼리 문자열을 만드는 부분과 D1을 때리는 부분을 나눠 둔다. 앞쪽은
// 순수 함수라 노드에서 그대로 검증할 수 있다.

import { utcDay } from './ids.js';

export const TOP = 100;
export const BOARD_TTL = 30;              // 초. 엣지 캐시 수명
export const RATE_WINDOW_MS = 60 * 60 * 1000;
export const RATE_MAX_RUNS = 30;          // 시간당. 사람이 한 시간에 30런이면 충분히 많다
export const RETENTION_DAYS = 30;

// 한 사람이 잘 나온 런을 여러 개 올려 상위권을 도배하지 못하게, 순위에는
// 플레이어별 최고 런 하나씩만 올린다.
//
// MIN()과 같이 쓴 bare column(nickname, rounds, created_at)은 SQLite에서
// "최솟값을 낸 바로 그 행의 값"으로 정해져 있다. 표준 SQL은 아니지만
// D1은 SQLite이므로 보장된 동작이고, 상관 서브쿼리로 같은 걸 하는 것보다
// 읽는 행 수가 훨씬 적다 (무료 티어가 하루 500만 행이다).
export function boardQuery(scope, now = Date.now()){
  const daily = scope === 'today';
  const sql =
    'SELECT nickname, MIN(avg_error) AS avg_error, rounds, created_at' +
    '  FROM runs' +
    ' WHERE flagged = 0' + (daily ? ' AND day = ?' : '') +
    ' GROUP BY player_id' +
    ' ORDER BY avg_error ASC, created_at ASC' +
    ' LIMIT ' + TOP;
  return { sql, args: daily ? [utcDay(now)] : [] };
}

// 이 기록이 몇 등인지. 자기보다 나은 플레이어 수 + 1이다.
export function rankQuery(scope, avgError, now = Date.now()){
  const daily = scope === 'today';
  const sql =
    'SELECT COUNT(*) AS better FROM (' +
    '  SELECT MIN(avg_error) AS m FROM runs' +
    '   WHERE flagged = 0' + (daily ? ' AND day = ?' : '') +
    '   GROUP BY player_id' +
    ') WHERE m < ?';
  return { sql, args: daily ? [utcDay(now), avgError] : [avgError] };
}

export function scopeOf(raw){
  return raw === 'today' ? 'today' : 'all';
}

// ── D1 ────────────────────────────────────

export async function readBoard(db, scope, now = Date.now()){
  const { sql, args } = boardQuery(scope, now);
  const { results } = await db.prepare(sql).bind(...args).all();
  return (results || []).map((r, i) => ({
    rank: i + 1,
    nickname: r.nickname,
    avgError: r.avg_error,
    rounds: r.rounds,
    at: r.created_at,
  }));
}

export async function rankFor(db, scope, avgError, now = Date.now()){
  const { sql, args } = rankQuery(scope, avgError, now);
  const row = await db.prepare(sql).bind(...args).first();
  return (row ? row.better : 0) + 1;
}

export async function recentRunCount(db, player, now = Date.now()){
  const row = await db.prepare(
    'SELECT COUNT(*) AS n FROM runs WHERE player_id = ? AND created_at > ?'
  ).bind(player, now - RATE_WINDOW_MS).first();
  return row ? row.n : 0;
}

export async function insertRun(db, row){
  // run_id가 PRIMARY KEY다. 같은 런을 두 번 제출하면 여기서 걸린다 —
  // 애플리케이션에서 먼저 조회하고 넣는 것보다 경합에 강하다.
  await db.prepare(
    'INSERT INTO runs (run_id, player_id, nickname, avg_error, rounds, day, created_at, flagged)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    row.runId, row.player, row.nickname, row.avgError,
    row.rounds, row.day, row.createdAt, row.flagged ? 1 : 0
  ).run();
}

// 보관 기간이 지난 기록을 지운다. 무기한 쌓을 이유가 없다 — 저장소와
// 개인정보 양쪽에 낫다. 하루 한 번 cron이 부른다.
//
// 다만 **플레이어별 최고 런은 남긴다.** 그냥 오래된 걸 다 지우면 '전체
// 기간' 보드가 조용히 '최근 30일' 보드가 되어 버린다. 지우려는 건 순위에
// 한 번도 안 걸리는 나머지 런들이다.
export function pruneQuery(now = Date.now()){
  return {
    sql:
      'DELETE FROM runs WHERE created_at < ? AND run_id NOT IN (' +
      '  SELECT run_id FROM (' +
      '    SELECT run_id, MIN(avg_error) FROM runs WHERE flagged = 0 GROUP BY player_id' +
      '  )' +
      ')',
    args: [now - RETENTION_DAYS * 24 * 60 * 60 * 1000],
  };
}

export async function prune(db, now = Date.now()){
  const { sql, args } = pruneQuery(now);
  const r = await db.prepare(sql).bind(...args).run();
  return r.meta ? r.meta.changes : 0;
}
