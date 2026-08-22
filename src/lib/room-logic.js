// 방 라운드의 판정 규칙. 순수 함수만 둔다 — Durable Object를 띄우지 않고
// 노드에서 그대로 검증할 수 있어야 한다.

export const MAX_PLAYERS = 8;

// 카운트다운. 서버가 이만큼 뒤의 시각을 잡아 브로드캐스트하면, 각자
// 자기 시계 보정값을 빼서 같은 순간에 시작한다.
export const COUNTDOWN_MS = 3000;

// 목표를 넘겨도 이만큼은 기다려 준다. 그 뒤엔 미제출로 넘어간다.
export const ROUND_GRACE_MS = 6000;

// 마지막 활동 후 이만큼 지나면 방을 정리한다.
export const IDLE_MS = 30 * 60 * 1000;

// 도착창. stop이 서버에 닿은 시각이 startAt + elapsed 에서 얼마나
// 벗어나도 되는지.
//
// 음수 쪽이 좁은 게 핵심이다. "3.000초를 쟀다"면서 시작 0.4초 만에
// 도착하는 메시지는 물리적으로 불가능하다 — 값을 지어낸 것이다.
// 양수 쪽은 느린 회선을 봐줘야 해서 넉넉하게 둔다.
export const ARRIVE_MIN_MS = -150;
export const ARRIVE_MAX_MS = 2500;

export function arrivalOk({ startAt, elapsed, arrivedAt }){
  const drift = arrivedAt - (startAt + elapsed * 1000);
  return drift >= ARRIVE_MIN_MS && drift <= ARRIVE_MAX_MS;
}

export function roundDeadline(startAt, target){
  return startAt + target * 1000 + ROUND_GRACE_MS;
}

// 라운드 순위. 목표에 가까운 순, 미제출·부정 도착은 뒤로.
export function standingsOf({ target, submissions, players }){
  const rows = players.map(p => {
    const s = submissions[p.id];
    const valid = s && s.ok;
    return {
      id: p.id,
      name: p.name,
      elapsed: valid ? s.elapsed : null,
      error: valid ? s.elapsed - target : null,
      dnf: !valid,
    };
  });

  rows.sort((a, b) => {
    if (a.dnf !== b.dnf) return a.dnf ? 1 : -1;
    if (a.dnf) return a.name.localeCompare(b.name);
    return Math.abs(a.error) - Math.abs(b.error);
  });

  rows.forEach((r, i) => { r.rank = r.dnf ? null : i + 1; });
  return rows;
}

// 라운드 1위에게 1점. 완전 동점이면 둘 다 준다 — 부동소수점 값이
// 정확히 같을 일은 거의 없지만, 그때 한 명을 임의로 떨어뜨릴 이유도 없다.
export function awardPoints(standings, scores){
  const next = { ...scores };
  const top = standings.find(r => !r.dnf);
  if (!top) return next;
  for (const r of standings){
    if (!r.dnf && Math.abs(r.error) === Math.abs(top.error))
      next[r.id] = (next[r.id] || 0) + 1;
  }
  return next;
}

// 방장이 나가면 남은 사람 중 가장 먼저 들어온 사람이 이어받는다.
export function nextHost(players, leavingId){
  const rest = players.filter(p => p.id !== leavingId);
  if (!rest.length) return null;
  return rest.reduce((a, b) => (a.joinedAt <= b.joinedAt ? a : b)).id;
}
