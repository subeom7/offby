// 순위에 올릴 '런'의 발급과 검증.
//
// 먼저 인정하고 갈 것: 클라이언트가 시간을 재는 게임에서 부정을 완전히
// 막을 수는 없다. 콘솔 한 줄이면 값을 지어낼 수 있다. 목표는 완벽한
// 차단이 아니라 (1) 가벼운 부정을 귀찮게 만들고 (2) 사람이 낼 수 없는
// 기록을 순위에서 빼는 것이다.

import { sign, verify } from './sign.js';

export const RUN_ROUNDS = 10;
export const MIN_TARGET = 2, MAX_TARGET = 9;

// public/index.html의 LOCKOUT과 같은 값이어야 한다. 벽시계 하한을 계산할
// 때 이 대기 시간이 반드시 끼기 때문에 서버도 알아야 한다.
export const LOCKOUT_MS = 650;

// 토큰 수명. 상한을 여기 하나로만 둔다 — 런 도중에 자리를 비우는 건
// 부정이 아니므로 "너무 오래 걸렸다"로 거절하지 않는다.
export const TOKEN_TTL_MS = 30 * 60 * 1000;

// 사람이 낼 수 있는 평균 절대오차의 하한.
//
// 이 숫자에는 아직 근거가 없다. 실측 분포를 모으기 전이라 어떤 값을
// 박아도 임의적이다. 그래서 여기 걸린 런을 **버리지 않는다** — flagged로
// 저장해 두고 순위에서만 뺀다. 나중에 분포를 보고 임계값을 정할 때
// 데이터가 남아 있어야 한다.
export const HUMAN_FLOOR = 0.008;

// 목표 10개를 미리 뽑는다. 규칙은 솔로와 같다 — 정수 2~9, 같은 값이
// 연속으로 나오지 않게.
//
// "같은 값이 나오면 다시 뽑기"로 쓰지 않는다. rand가 상수를 주면 그
// 반복문은 영원히 안 끝난다 — 서버에서 도는 코드에 호출자가 넘긴 함수를
// 무한 재시도하는 자리를 두면 안 된다. 직전 값을 뺀 후보에서 한 번만
// 뽑으면 어떤 rand를 줘도 반드시 끝난다.
export function makeTargets(n = RUN_ROUNDS, rand = defaultRand){
  const out = [];
  let prev = 0;
  for (let i = 0; i < n; i++){
    const t = pickTarget(prev, rand);
    out.push(t);
    prev = t;
  }
  return out;
}

// 목표 하나. 방(src/room.js)도 라운드마다 이걸 쓴다.
export function pickTarget(prev = 0, rand = defaultRand){
  const pool = [];
  for (let v = MIN_TARGET; v <= MAX_TARGET; v++) if (v !== prev) pool.push(v);
  // rand가 1.0을 주더라도 범위를 넘지 않게 잘라 둔다.
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}

function defaultRand(){
  return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
}

// 서명 대상. 순서와 구분자가 고정이어야 한다 — 필드를 이어 붙일 때
// 경계가 모호하면 다른 조합이 같은 문자열이 될 수 있다.
export function runPayload({ runId, targets, issuedAt, player }){
  return ['v1', runId, targets.join(','), issuedAt, player].join('|');
}

export async function issueRun(secret, { player, now = Date.now(), rand = defaultRand }){
  const runId = crypto.randomUUID();
  const targets = makeTargets(RUN_ROUNDS, rand);
  const issuedAt = now;
  const token = await sign(secret, runPayload({ runId, targets, issuedAt, player }));
  return { runId, targets, issuedAt, token };
}

// 제출된 런을 본다. 반환은 {ok:false, reason} 또는 {ok:true, avgError, flagged}.
export function validateRun({ targets, attempts, issuedAt, now }){
  if (!Array.isArray(attempts) || attempts.length !== targets.length)
    return { ok: false, reason: 'rounds' };

  if (!(now - issuedAt >= 0) || now - issuedAt > TOKEN_TTL_MS)
    return { ok: false, reason: 'expired' };

  const errs = [];
  let playedMs = 0;

  for (let i = 0; i < attempts.length; i++){
    const a = attempts[i];
    if (!a || a.target !== targets[i]) return { ok: false, reason: 'target' };

    const e = a.elapsed;
    // 음수·NaN·무한대가 여기서 걸린다. 상한은 목표의 4배 + 10초 —
    // 그보다 오래 끌었다면 게임을 한 게 아니다.
    if (typeof e !== 'number' || !isFinite(e) || e <= 0 || e > targets[i] * 4 + 10)
      return { ok: false, reason: 'elapsed' };

    playedMs += e * 1000;
    errs.push(Math.abs(e - targets[i]));
  }

  // 벽시계 하한. 55초짜리 런을 3초 만에 제출할 수는 없다.
  //
  // 락아웃은 시도 사이에만 끼므로 n-1번이다. 발급 시각은 서버가 찍고
  // 네트워크 지연만큼 클라이언트보다 앞서 있으므로, 이 하한은 실제
  // 플레이보다 항상 느슨하다 — 정직한 런이 여기 걸리지 않는다.
  const floorMs = playedMs + LOCKOUT_MS * (attempts.length - 1);
  if (now - issuedAt < floorMs) return { ok: false, reason: 'wallclock' };

  const avgError = errs.reduce((a, b) => a + b, 0) / errs.length;
  return { ok: true, avgError, flagged: avgError < HUMAN_FLOOR };
}

// 토큰이 이 런의 것이 맞는지. 서명이 목표 배열까지 덮으므로, 목표를
// 바꿔치기하면 여기서 걸린다.
export async function checkToken(secret, { runId, targets, issuedAt, player, token }){
  return verify(secret, runPayload({ runId, targets, issuedAt, player }), token);
}
