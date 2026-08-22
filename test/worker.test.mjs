// 워커의 순수 로직을 검증한다.
//
//     npm run test:worker
//
// 워커 런타임(wrangler)을 띄우지 않는다. src/lib/*는 WebCrypto만 쓰므로
// 노드에서 그대로 import된다 — 여기서 깨지기 쉬운 건 바인딩이 아니라
// 검증 규칙(서명·벽시계·목표 일치)이고, 그건 이렇게 보는 게 빠르다.

import {
  makeTargets, validateRun, issueRun, checkToken, runPayload,
  RUN_ROUNDS, MIN_TARGET, MAX_TARGET, LOCKOUT_MS, HUMAN_FLOOR, TOKEN_TTL_MS,
} from '../src/lib/run.js';
import { sign, verify } from '../src/lib/sign.js';
import {
  makeRoomCode, isRoomCode, cleanNickname, playerHash, utcDay,
  CODE_ALPHABET, CODE_LENGTH, NICK_MAX,
} from '../src/lib/ids.js';
import { boardQuery, rankQuery, pruneQuery, scopeOf } from '../src/lib/board.js';
import {
  standingsOf, awardPoints, arrivalOk, roundDeadline, nextHost,
} from '../src/lib/room-logic.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [o] ${name}`); }
  else { fail++; console.log(`  [X] ${name}  ${detail}`); }
}

const SECRET = 'test-secret-do-not-use';

// 정직한 런 하나를 만든다. errs는 시도별 오차(초).
function honestRun(targets, errs, issuedAt = 0) {
  const attempts = targets.map((t, i) => ({ target: t, elapsed: t + errs[i] }));
  const playedMs = attempts.reduce((a, x) => a + x.elapsed * 1000, 0);
  // 사람이 실제로 쳤다면 최소한 이만큼은 벽시계가 흘렀다.
  const now = issuedAt + playedMs + LOCKOUT_MS * (attempts.length - 1) + 3000;
  return { attempts, now };
}

console.log('\n목표 발급');
{
  const t = makeTargets();
  check('10개', t.length === RUN_ROUNDS, `got ${t.length}`);
  check('정수 2~9', t.every(n => Number.isInteger(n) && n >= MIN_TARGET && n <= MAX_TARGET), t.join(','));

  // 같은 목표가 연달아 나오면 "아까 그 감각"을 그대로 쓰게 된다.
  let repeats = 0;
  for (let i = 0; i < 300; i++) {
    const s = makeTargets();
    for (let j = 1; j < s.length; j++) if (s[j] === s[j - 1]) repeats++;
  }
  check('연속 중복 없음', repeats === 0, `${repeats}회`);

  // rand를 주입할 수 있어야 테스트가 흔들리지 않는다.
  const fixed = makeTargets(4, () => 0.5);
  check('rand 주입 가능', fixed.length === 4, fixed.join(','));
}

console.log('\n서명');
{
  const payload = runPayload({ runId: 'r1', targets: [2, 3], issuedAt: 100, player: 'p1' });
  const token = await sign(SECRET, payload);
  check('검증 통과', await verify(SECRET, payload, token));
  check('내용이 바뀌면 실패', !await verify(SECRET, payload + 'x', token));
  check('키가 다르면 실패', !await verify(SECRET + 'x', payload, token));
  check('토큰이 문자열이 아니면 실패', !await verify(SECRET, payload, null));
  check('길이가 다르면 실패', !await verify(SECRET, payload, token.slice(0, -1)));

  // 구분자가 고정이라 필드 경계가 모호하면 안 된다.
  const a = runPayload({ runId: 'r', targets: [2, 3], issuedAt: 1, player: 'p' });
  const b = runPayload({ runId: 'r', targets: [2], issuedAt: 31, player: 'p' });
  check('필드 경계가 섞이지 않음', a !== b, a + ' vs ' + b);
}

console.log('\n런 발급 → 검증 왕복');
{
  const issued = await issueRun(SECRET, { player: 'p1', now: 1000 });
  check('토큰이 자기 런을 통과', await checkToken(SECRET, { ...issued, player: 'p1' }));

  // 쉬운 목표로 바꿔치기하면 서명이 안 맞는다.
  const swapped = { ...issued, targets: issued.targets.map(() => 2) };
  check('목표 바꿔치기 거부', !await checkToken(SECRET, { ...swapped, player: 'p1' }));
  check('다른 사람 토큰 거부', !await checkToken(SECRET, { ...issued, player: 'p2' }));
}

console.log('\n런 검증');
{
  const targets = makeTargets();
  const errs = targets.map(() => 0.05);
  const { attempts, now } = honestRun(targets, errs);

  const ok = validateRun({ targets, attempts, issuedAt: 0, now });
  check('정직한 런 통과', ok.ok, ok.reason);
  check('평균오차 계산', ok.ok && Math.abs(ok.avgError - 0.05) < 1e-9, ok.avgError);
  check('플래그 안 됨', ok.ok && !ok.flagged);

  // 벽시계 하한 — 55초짜리 런을 3초 만에 제출할 수는 없다.
  const fast = validateRun({ targets, attempts, issuedAt: 0, now: 3000 });
  check('즉시 제출 거부', !fast.ok && fast.reason === 'wallclock', fast.reason);

  // 딱 하한선 위/아래
  const playedMs = attempts.reduce((a, x) => a + x.elapsed * 1000, 0);
  const floor = playedMs + LOCKOUT_MS * (attempts.length - 1);
  check('하한 바로 아래 거부', !validateRun({ targets, attempts, issuedAt: 0, now: floor - 1 }).ok);
  check('하한 정확히 통과', validateRun({ targets, attempts, issuedAt: 0, now: floor }).ok);

  // 시도 수가 안 맞으면 거부
  check('9회 거부', !validateRun({ targets, attempts: attempts.slice(1), issuedAt: 0, now }).ok);

  // 목표가 안 맞으면 거부 (서명을 통과했어도 본문이 어긋난 경우)
  const wrong = attempts.map((a, i) => i === 3 ? { ...a, target: a.target === 2 ? 3 : 2 } : a);
  const w = validateRun({ targets, attempts: wrong, issuedAt: 0, now });
  check('목표 불일치 거부', !w.ok && w.reason === 'target', w.reason);

  // 말이 안 되는 elapsed
  for (const junk of [0, -1, NaN, Infinity, '3', null, undefined]) {
    const one = attempts.map((a, i) => i === 0 ? { ...a, elapsed: junk } : a);
    const r = validateRun({ targets, attempts: one, issuedAt: 0, now });
    check(`elapsed=${String(junk)} 거부`, !r.ok && r.reason === 'elapsed', r.reason);
  }

  // 토큰 수명
  const old = validateRun({ targets, attempts, issuedAt: 0, now: TOKEN_TTL_MS + 1 });
  check('만료 거부', !old.ok && old.reason === 'expired', old.reason);
  check('음수 시간 거부', !validateRun({ targets, attempts, issuedAt: 1000, now: 0 }).ok);
}

console.log('\n사람의 한계 필터');
{
  const targets = makeTargets();
  const tiny = honestRun(targets, targets.map(() => HUMAN_FLOOR / 2));
  const r = validateRun({ targets, attempts: tiny.attempts, issuedAt: 0, now: tiny.now });

  // 버리지 않는다 — 저장은 하되 순위에서만 뺀다. 임계값에 근거가 생길
  // 때까지 데이터가 남아 있어야 한다.
  check('통과하되 플래그', r.ok && r.flagged, JSON.stringify(r));

  // 경계 자체를 정확히 재지 않는다. 0.008을 열 번 더해 나누면 부동소수점
  // 때문에 0.00799...가 나오고, 애초에 HUMAN_FLOOR에는 근거가 없어서
  // 경계의 어느 쪽인지가 의미를 갖지 않는다. 확실히 위면 안 걸리는 것,
  // 확실히 아래면 걸리는 것 — 검증할 값어치가 있는 건 그거다.
  const edge = honestRun(targets, targets.map(() => HUMAN_FLOOR * 2));
  const e = validateRun({ targets, attempts: edge.attempts, issuedAt: 0, now: edge.now });
  check('한계 위면 플래그 아님', e.ok && !e.flagged, JSON.stringify(e));
}

console.log('\n방 코드');
{
  check('길이', makeRoomCode().length === CODE_LENGTH);
  check('알파벳 안', [...makeRoomCode()].every(c => CODE_ALPHABET.includes(c)));
  check('헷갈리는 글자 없음', !/[O0I1]/.test(CODE_ALPHABET));
  check('isRoomCode 참', isRoomCode(makeRoomCode()));
  check('소문자 거부', !isRoomCode('abcd'));
  check('길이 다르면 거부', !isRoomCode('ABC'));
  check('제외된 글자 거부', !isRoomCode('AB0O'));

  // 32글자가 256을 정확히 나누므로 편향이 없어야 한다.
  const seen = new Set();
  for (let i = 0; i < 4000; i++) for (const c of makeRoomCode()) seen.add(c);
  check('알파벳 전체가 나옴', seen.size === CODE_ALPHABET.length, `${seen.size}/${CODE_ALPHABET.length}`);
}

console.log('\n닉네임');
{
  check('그대로', cleanNickname('subeom') === 'subeom');
  check('공백 정리', cleanNickname('  a   b  ') === 'a b');
  check('길이 제한', cleanNickname('x'.repeat(50)).length === NICK_MAX);
  check('빈 값은 기본값', cleanNickname('   ') === 'anon');
  check('문자열이 아니면 기본값', cleanNickname(null) === 'anon');
  check('한글 통과', cleanNickname('수범') === '수범');

  // 표를 뒤집는 문자를 턴다.
  const rtl = 'a' + String.fromCharCode(0x202e) + 'b';
  check('방향 재정의 제거', cleanNickname(rtl) === 'ab', JSON.stringify(cleanNickname(rtl)));
  const nul = 'a' + String.fromCharCode(0) + 'b';
  check('제어문자 제거', cleanNickname(nul) === 'ab', JSON.stringify(cleanNickname(nul)));
  const zw = 'a' + String.fromCharCode(0x200b) + 'b';
  check('폭 없는 공백 제거', cleanNickname(zw) === 'ab');

  // 이모지가 반쪽으로 잘리면 깨진 글자가 표에 남는다.
  const emoji = cleanNickname('X'.repeat(NICK_MAX - 1) + '\u{1F600}');
  check('이모지가 안 잘림', [...emoji].length === NICK_MAX && emoji.endsWith('\u{1F600}'), emoji);
}

console.log('\n플레이어 해시');
{
  const a = await playerHash(SECRET, 'uuid-1');
  const b = await playerHash(SECRET, 'uuid-1');
  const c = await playerHash(SECRET, 'uuid-2');
  check('같은 입력 같은 값', a === b);
  check('다른 입력 다른 값', a !== c);
  check('원본이 안 보임', !a.includes('uuid'), a);
  check('키가 다르면 값도 다름', a !== await playerHash('other', 'uuid-1'));
}

console.log('\n날짜 · 보드 쿼리');
{
  check('utcDay 형식', /^\d{4}-\d{2}-\d{2}$/.test(utcDay(Date.now())));
  check('UTC 자정 경계', utcDay(Date.UTC(2026, 0, 2) - 1) === '2026-01-01');
  check('UTC 자정 직후', utcDay(Date.UTC(2026, 0, 2)) === '2026-01-02');

  check('scope 기본은 전체', scopeOf(undefined) === 'all' && scopeOf('junk') === 'all');
  check('scope today', scopeOf('today') === 'today');

  const all = boardQuery('all');
  const day = boardQuery('today');
  check('전체는 day 조건 없음', !all.sql.includes('day = ?') && all.args.length === 0);
  check('일간은 day로 거름', day.sql.includes('day = ?') && day.args.length === 1);
  check('플래그 제외', all.sql.includes('flagged = 0') && day.sql.includes('flagged = 0'));
  check('플레이어별 하나', all.sql.includes('GROUP BY player_id'));
  check('동점은 먼저 낸 사람', all.sql.includes('ORDER BY avg_error ASC, created_at ASC'));

  const r = rankQuery('today', 0.05);
  check('rank 인자 순서', r.args.length === 2 && r.args[1] === 0.05, JSON.stringify(r.args));
  check('rank는 나은 사람을 셈', r.sql.includes('m < ?'));

  // 오래된 걸 다 지우면 '전체 기간' 보드가 조용히 '최근 30일'이 된다.
  const p = pruneQuery(Date.now());
  check('prune이 최고 기록은 남김', p.sql.includes('NOT IN') && p.sql.includes('MIN(avg_error)'));
}

console.log('\n방 라운드 판정');
{
  const players = [
    { id: 'a', name: 'A', joinedAt: 1 },
    { id: 'b', name: 'B', joinedAt: 2 },
    { id: 'c', name: 'C', joinedAt: 3 },
  ];

  // 목표 5초. A는 0.03 늦고, B는 0.10 빠르고, C는 안 냈다.
  const subs = { a: { elapsed: 5.03, ok: true }, b: { elapsed: 4.9, ok: true } };
  const st = standingsOf({ target: 5, submissions: subs, players });

  check('가까운 순', st[0].id === 'a' && st[1].id === 'b', st.map(r => r.id).join(','));
  check('미제출은 뒤로', st[2].id === 'c' && st[2].dnf);
  check('DNF는 등수 없음', st[2].rank === null);
  check('등수 매김', st[0].rank === 1 && st[1].rank === 2);
  check('부호가 방향', st[0].error > 0 && st[1].error < 0, `${st[0].error} ${st[1].error}`);

  // 빠른 쪽이 더 가까우면 빠른 쪽이 이긴다 — 절대오차로 본다.
  const near = standingsOf({
    target: 5,
    submissions: { a: { elapsed: 5.20, ok: true }, b: { elapsed: 4.95, ok: true } },
    players: players.slice(0, 2),
  });
  check('절대오차로 비교', near[0].id === 'b', near.map(r => r.id).join(','));

  // 도착창을 못 넘긴 제출은 낸 것으로 치지 않는다.
  const cheated = standingsOf({
    target: 5,
    submissions: { a: { elapsed: 5.0, ok: false }, b: { elapsed: 5.5, ok: true } },
    players: players.slice(0, 2),
  });
  check('부정 도착은 DNF', cheated[0].id === 'b' && cheated[1].dnf);

  check('1위에게 1점', awardPoints(st, {}).a === 1);
  check('나머지는 0점', awardPoints(st, {}).b === undefined);
  check('점수가 누적됨', awardPoints(st, { a: 2 }).a === 3);
  check('전원 DNF면 점수 없음', Object.keys(awardPoints(
    standingsOf({ target: 5, submissions: {}, players }), {})).length === 0);

  // 완전 동점이면 한 명을 임의로 떨어뜨릴 이유가 없다.
  const tied = standingsOf({
    target: 5,
    submissions: { a: { elapsed: 5.1, ok: true }, b: { elapsed: 4.9, ok: true } },
    players: players.slice(0, 2),
  });
  const tp = awardPoints(tied, {});
  check('동점은 둘 다', tp.a === 1 && tp.b === 1, JSON.stringify(tp));
}

console.log('\n도착창');
{
  const startAt = 1_000_000;
  const at = ms => ({ startAt, elapsed: 3, arrivedAt: startAt + ms });

  check('정확히 3초', arrivalOk(at(3000)));
  check('네트워크 지연 200ms', arrivalOk(at(3200)));
  check('느린 회선 2초', arrivalOk(at(5000)));
  check('너무 느리면 거부', !arrivalOk(at(6000)));

  // 이게 핵심이다. "3.000초를 쟀다"면서 시작 0.4초 만에 도착하는 메시지는
  // 물리적으로 불가능하다.
  check('불가능하게 빠른 응답 거부', !arrivalOk(at(400)));
  check('약간 이른 건 봐줌(시계 오차)', arrivalOk(at(2900)));
  check('많이 이르면 거부', !arrivalOk(at(2500)));

  check('마감은 목표 뒤 여유', roundDeadline(startAt, 5) > startAt + 5000);
}

console.log('\n방장 승계');
{
  const ps = [{ id: 'a', joinedAt: 1 }, { id: 'b', joinedAt: 2 }, { id: 'c', joinedAt: 3 }];
  check('가장 먼저 들어온 사람', nextHost(ps, 'a') === 'b');
  check('중간이 나가도 유지', nextHost(ps, 'b') === 'a');
  check('마지막 한 명이 나가면 없음', nextHost([{ id: 'a', joinedAt: 1 }], 'a') === null);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
