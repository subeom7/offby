// offby 워커.
//
// 정적 자산은 그대로 엣지에서 나간다. 여기서 코드가 처리하는 건 /api/*와
// 방 URL(/r/*) 뿐이다 — 나머지는 전부 env.ASSETS로 넘긴다.

import { issueRun, validateRun, checkToken, RUN_ROUNDS } from './lib/run.js';
import { cleanNickname, playerHash, utcDay, makeRoomCode, isRoomCode } from './lib/ids.js';
import {
  readBoard, rankFor, insertRun, recentRunCount, prune,
  scopeOf, BOARD_TTL, RATE_MAX_RUNS,
} from './lib/board.js';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

const bad = (reason, status = 400) => json({ error: reason }, status);

// 설정이 덜 된 상태(D1 미생성, 시크릿 미설정)를 500이 아니라 503으로
// 구분해 준다. 클라이언트는 이걸 보고 조용히 솔로 모드로 떨어진다.
const needsSetup = what => json({ error: 'unconfigured', what }, 503);

// 본문은 작다. 큰 걸 받아 파싱하다 CPU(무료 티어 10ms)를 태울 이유가 없다.
const MAX_BODY = 8 * 1024;

async function readJson(request){
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')){
      try {
        return await api(request, env, ctx, url);
      } catch (e) {
        // 스택을 그대로 내보내지 않는다. 로그로만 남긴다.
        console.error('api', url.pathname, e && e.stack || e);
        return bad('internal', 500);
      }
    }

    // 방 URL은 index.html을 그대로 내되 색인은 막는다. 방 코드가 검색에
    // 걸리면 모르는 사람이 남의 방에 들어온다.
    if (url.pathname === '/r' || url.pathname.startsWith('/r/')){
      const page = await env.ASSETS.fetch(new URL('/', request.url));
      const headers = new Headers(page.headers);
      headers.set('X-Robots-Tag', 'noindex, nofollow');
      headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
      return new Response(page.body, { status: page.status, headers });
    }

    return env.ASSETS.fetch(request);
  },

  // 하루 한 번. 보관 기간이 지난 런을 정리한다.
  async scheduled(event, env, ctx){
    if (!env.DB) return;
    ctx.waitUntil(prune(env.DB).then(n => console.log('pruned', n)));
  },
};

async function api(request, env, ctx, url){
  const route = url.pathname.slice('/api/'.length);

  if (route === 'board' && request.method === 'GET')      return board(request, env, ctx, url);
  if (route === 'run/start' && request.method === 'POST') return runStart(request, env);
  if (route === 'run/finish' && request.method === 'POST') return runFinish(request, env, ctx);
  if (route === 'room' && request.method === 'POST')      return roomCreate(env);

  // /api/room/ABCD/ws
  const room = route.match(/^room\/([A-Z0-9]+)\/ws$/);
  if (room) return roomSocket(request, env, room[1]);

  return bad('not found', 404);
}

// ── 방 ────────────────────────────────────

function roomStub(env, code){
  return env.ROOM.get(env.ROOM.idFromName(code));
}

async function roomCreate(env){
  if (!env.ROOM) return needsSetup('do');

  // 코드가 4자(32^4 ≈ 100만)라 부딪힐 수 있다. 부딪히면 다시 뽑는다 —
  // 방이 그만큼 동시에 살아 있을 일은 없으므로 몇 번이면 충분하다.
  for (let i = 0; i < 5; i++){
    const code = makeRoomCode();
    const res = await roomStub(env, code).fetch('https://room/claim');
    const { ok } = await res.json();
    if (ok) return json({ code });
  }
  return bad('busy', 503);
}

async function roomSocket(request, env, code){
  if (!env.ROOM) return needsSetup('do');
  if (!isRoomCode(code)) return bad('code', 404);
  if (request.headers.get('Upgrade') !== 'websocket') return bad('websocket', 426);

  // 원본 요청을 그대로 감싸 넘긴다 — Upgrade 헤더가 살아 있어야 DO가
  // 업그레이드를 받아 준다.
  return roomStub(env, code).fetch(new Request('https://room/ws', request));
}

// ── 리더보드 ──────────────────────────────

async function board(request, env, ctx, url){
  if (!env.DB) return needsSetup('d1');

  const scope = scopeOf(url.searchParams.get('scope'));

  // 상위 100개는 자주 읽히고 30초쯤 늦어도 아무도 신경 쓰지 않는다.
  // 매번 D1을 때리면 무료 티어(하루 500만 행)를 금방 쓴다.
  const key = new Request(new URL('/api/board?scope=' + scope, url.origin), { method: 'GET' });
  const cache = caches.default;

  const hit = await cache.match(key);
  if (hit) return hit;

  const rows = await readBoard(env.DB, scope);
  const res = json({ scope, board: rows }, 200, {
    'Cache-Control': 'public, max-age=' + BOARD_TTL,
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

// ── 런 ────────────────────────────────────

async function runStart(request, env){
  if (!env.RUN_SECRET) return needsSetup('secret');

  const body = await readJson(request);
  if (!body || typeof body.playerId !== 'string') return bad('playerId');

  const player = await playerHash(env.RUN_SECRET, body.playerId);
  const { runId, targets, issuedAt, token } = await issueRun(env.RUN_SECRET, { player });

  // 목표 10개를 미리 준다. 시도마다 발급하면 650ms 락아웃 안에 네트워크
  // 왕복이 끼어 게임이 끊기는데, 막아 주는 건 사실상 없다 — 목표는 어차피
  // 매 시도 전에 화면에 뜨므로 봇은 지금도 안다. 실제로 막는 건 제출 때의
  // 벽시계 하한과 사람의 한계 필터다(src/lib/run.js).
  return json({ runId, targets, issuedAt, token, rounds: RUN_ROUNDS });
}

async function runFinish(request, env, ctx){
  if (!env.RUN_SECRET) return needsSetup('secret');
  if (!env.DB) return needsSetup('d1');

  const body = await readJson(request);
  if (!body) return bad('body');

  const { runId, targets, issuedAt, token, attempts, playerId, nickname } = body;
  if (typeof runId !== 'string' || typeof playerId !== 'string') return bad('body');
  if (!Array.isArray(targets) || targets.length !== RUN_ROUNDS) return bad('targets');

  const player = await playerHash(env.RUN_SECRET, playerId);

  // 서명이 목표 배열까지 덮는다. 쉬운 목표로 바꿔치기하면 여기서 걸린다.
  if (!await checkToken(env.RUN_SECRET, { runId, targets, issuedAt, player, token }))
    return bad('token', 403);

  const now = Date.now();
  const verdict = validateRun({ targets, attempts, issuedAt, now });
  if (!verdict.ok) return bad(verdict.reason);

  if (await recentRunCount(env.DB, player, now) >= RATE_MAX_RUNS)
    return bad('rate', 429);

  const name = cleanNickname(nickname);
  try {
    await insertRun(env.DB, {
      runId, player, nickname: name,
      avgError: verdict.avgError,
      rounds: attempts.length,
      day: utcDay(now),
      createdAt: now,
      flagged: verdict.flagged,
    });
  } catch (e) {
    // run_id가 PRIMARY KEY다. 같은 런을 두 번 제출하면 여기로 온다.
    if (String(e && e.message).includes('UNIQUE')) return bad('replay', 409);
    throw e;
  }

  // 플래그된 런은 순위에 안 들어가므로 등수도 없다. 점수는 그대로 보여
  // 준다 — 본인에게는 자기 기록이다.
  const rank = verdict.flagged ? null : {
    today: await rankFor(env.DB, 'today', verdict.avgError, now),
    all:   await rankFor(env.DB, 'all',   verdict.avgError, now),
  };

  return json({ avgError: verdict.avgError, flagged: verdict.flagged, rank, nickname: name });
}

// Durable Object 클래스는 워커 진입점에서 내보내야 런타임이 찾는다.
export { Room } from './room.js';
