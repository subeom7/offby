-- offby 리더보드.
--
--   npx wrangler d1 execute offby --file=src/schema.sql --remote
--
-- 한 행 = 완주한 런 하나(연속 10회). 순위에는 플레이어별 최고 런만
-- 올라간다(src/lib/board.js).

CREATE TABLE IF NOT EXISTS runs (
  run_id     TEXT PRIMARY KEY,          -- 재사용 차단. 같은 런을 두 번 못 넣는다
  player_id  TEXT NOT NULL,             -- 기기 UUID를 서버 비밀키로 해시한 값
  nickname   TEXT NOT NULL,
  avg_error  REAL NOT NULL,             -- 10회 평균 절대오차(초)
  rounds     INTEGER NOT NULL,
  day        TEXT NOT NULL,             -- 'YYYY-MM-DD' UTC. 일간 보드용
  created_at INTEGER NOT NULL,          -- epoch ms
  flagged    INTEGER NOT NULL DEFAULT 0 -- 사람의 한계 아래. 저장하되 순위에서 제외
);

-- 보드 쿼리는 flagged로 거르고 avg_error로 정렬한다. 동점은 먼저 낸
-- 사람이 앞선다.
CREATE INDEX IF NOT EXISTS idx_all  ON runs(flagged, avg_error, created_at);
CREATE INDEX IF NOT EXISTS idx_day  ON runs(day, flagged, avg_error, created_at);

-- 레이트리밋: 한 플레이어의 최근 제출을 센다.
CREATE INDEX IF NOT EXISTS idx_rate ON runs(player_id, created_at DESC);
