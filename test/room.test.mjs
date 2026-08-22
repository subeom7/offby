// 방(Durable Object)의 상태 전이를 검증한다.
//
//     npm run test:room
//
// 워커 런타임을 띄우지 않는다. wrangler는 Node 22를 요구하는데 CI와 로컬은
// 20이고, 어차피 여기서 깨지기 쉬운 건 런타임 바인딩이 아니라 **순서**다 —
// 누가 방장인가, 나간 사람을 기다리다 라운드가 멈추지 않는가, 마감에
// 안 낸 사람이 DNF로 처리되는가. ctx와 소켓을 대역으로 두면 그 순서를
// 시간까지 통제하면서 볼 수 있다.
//
// cloudflare:workers 는 test/stub/hooks.mjs 가 대역으로 돌린다.

import { Room } from '../src/room.js';
import { MAX_PLAYERS, COUNTDOWN_MS, IDLE_MS } from '../src/lib/room-logic.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [o] ${name}`); }
  else { fail++; console.log(`  [X] ${name}  ${detail}`); }
}

// ── 대역 ──────────────────────────────────

let NOW = 1_700_000_000_000;
const realNow = Date.now;
Date.now = () => NOW;

class FakeWS {
  constructor(){ this.sent = []; this.attach = null; this.readyState = 1; }
  send(s){ this.sent.push(JSON.parse(s)); }
  serializeAttachment(v){ this.attach = v; }
  deserializeAttachment(){ return this.attach; }
  // 마지막으로 받은 t 종류의 메시지
  last(t){
    for (let i = this.sent.length - 1; i >= 0; i--)
      if (this.sent[i].t === t) return this.sent[i];
    return null;
  }
  count(t){ return this.sent.filter(m => m.t === t).length; }
}

class FakeCtx {
  constructor(){
    this.map = new Map();
    this.sockets = [];
    this.alarmAt = null;
    const self = this;
    this.storage = {
      async get(k){ return self.map.get(k); },
      async put(k, v){
        // DO 저장소는 직렬화된다. 소켓 같은 걸 실수로 넣으면 여기서 터진다.
        self.map.set(k, JSON.parse(JSON.stringify(v)));
      },
      async deleteAll(){ self.map.clear(); },
      async setAlarm(at){ self.alarmAt = at; },
    };
  }
  getWebSockets(){ return this.sockets; }
  acceptWebSocket(ws){ this.sockets.push(ws); }
}

// 방 하나와 그 안의 플레이어들을 만든다.
function openRoom(){
  const ctx = new FakeCtx();
  const room = new Room(ctx, {});
  return {
    ctx, room,
    async join(id, name){
      const ws = new FakeWS();
      ctx.acceptWebSocket(ws);
      await room.webSocketMessage(ws, JSON.stringify({ t: 'hello', id, name }));
      return ws;
    },
    send(ws, m){ return room.webSocketMessage(ws, JSON.stringify(m)); },
  };
}

console.log('\n입장');
{
  const r = openRoom();
  const a = await r.join('a', 'Ann');

  const hi = a.last('welcome');
  check('welcome 받음', !!hi);
  check('내가 누구인지 알려줌', hi && hi.you === 'a', JSON.stringify(hi && hi.you));
  check('첫 사람이 방장', hi && hi.hostId === 'a');
  check('로스터에 한 명', hi && hi.roster.length === 1);
  check('진행 중인 라운드 없음', hi && hi.round === null);

  const b = await r.join('b', 'Bob');
  check('둘째도 들어옴', b.last('welcome').roster.length === 2);
  check('방장은 그대로', b.last('welcome').hostId === 'a');
  check('기존 사람에게도 로스터 갱신', a.last('roster').roster.length === 2);

  // 닉네임은 서버에서 턴다.
  const c = await r.join('c', '  ' + String.fromCharCode(0x202e) + 'Cat  ');
  const names = c.last('welcome').roster.map(p => p.name);
  check('닉네임 정제됨', names.includes('Cat'), JSON.stringify(names));

  check('저장 상태가 직렬화 가능', r.ctx.map.has('state'));
}

console.log('\n라운드 시작');
{
  const r = openRoom();
  const a = await r.join('a', 'Ann');
  const b = await r.join('b', 'Bob');

  // 방장이 아니면 못 연다.
  await r.send(b, { t: 'start' });
  check('방장이 아니면 시작 안 됨', !a.last('round'));

  await r.send(a, { t: 'start' });
  const round = a.last('round');
  check('라운드 브로드캐스트', !!round);
  check('모두가 받음', !!b.last('round'));
  check('목표가 정수 2~9', round && Number.isInteger(round.target)
        && round.target >= 2 && round.target <= 9, round && round.target);
  check('같은 목표를 모두가 받음', round.target === b.last('round').target);
  check('카운트다운 뒤에 시작', round.startAt === NOW + COUNTDOWN_MS, round.startAt - NOW);
  check('마감이 목표 뒤', round.deadline > round.startAt + round.target * 1000);
  check('알람이 마감에 맞춰짐', r.ctx.alarmAt === round.deadline, r.ctx.alarmAt);

  // 진행 중에 또 누르면 무시된다.
  const before = a.count('round');
  await r.send(a, { t: 'start' });
  check('진행 중 재시작 무시', a.count('round') === before);
}

console.log('\n라운드 판정');
{
  const r = openRoom();
  const a = await r.join('a', 'Ann');
  const b = await r.join('b', 'Bob');
  await r.send(a, { t: 'start' });

  const round = a.last('round');
  const target = round.target;

  // Ann은 0.03초 늦게, Bob은 0.20초 빠르게 멈춘다.
  NOW = round.startAt + (target + 0.03) * 1000 + 40;   // +40ms 네트워크 지연
  await r.send(a, { t: 'stop', roundId: round.roundId, elapsed: target + 0.03 });

  check('아직 결과 없음', !a.last('result'));
  check('제출 알림', !!b.last('submitted'), JSON.stringify(b.last('submitted')));

  NOW = round.startAt + (target - 0.20) * 1000 + 40;
  await r.send(b, { t: 'stop', roundId: round.roundId, elapsed: target - 0.20 });

  const res = a.last('result');
  check('전원 제출하면 바로 결과', !!res);
  check('목표를 알려줌', res && res.target === target);
  check('가까운 사람이 1위', res && res.standings[0].name === 'Ann',
        res && res.standings.map(s => s.name).join(','));
  check('1위에게 1점', res && res.roster.find(p => p.id === 'a').points === 1);
  check('2위는 0점', res && res.roster.find(p => p.id === 'b').points === 0);
  check('라운드 번호 1', res && res.roundNo === 1);

  // 다음 라운드로 점수가 누적된다.
  await r.send(a, { t: 'start' });
  const r2 = a.last('round');
  check('둘째 라운드 번호', r2.roundId === 2);
  check('직전과 다른 목표', r2.target !== target, `${r2.target} vs ${target}`);

  NOW = r2.startAt + (r2.target + 0.01) * 1000 + 30;
  await r.send(a, { t: 'stop', roundId: r2.roundId, elapsed: r2.target + 0.01 });
  NOW = r2.startAt + (r2.target + 0.50) * 1000 + 30;
  await r.send(b, { t: 'stop', roundId: r2.roundId, elapsed: r2.target + 0.50 });

  check('점수 누적', a.last('result').roster.find(p => p.id === 'a').points === 2,
        JSON.stringify(a.last('result').roster));
}

console.log('\n부정 제출');
{
  const r = openRoom();
  const a = await r.join('a', 'Ann');
  const b = await r.join('b', 'Bob');
  await r.send(a, { t: 'start' });
  const round = a.last('round');

  // "정확히 목표를 맞췄다"면서 시작 0.3초 만에 도착하는 메시지.
  // 물리적으로 불가능하다 — 값을 지어낸 것이다.
  NOW = round.startAt + 300;
  await r.send(a, { t: 'stop', roundId: round.roundId, elapsed: round.target });

  NOW = round.startAt + (round.target + 0.4) * 1000 + 30;
  await r.send(b, { t: 'stop', roundId: round.roundId, elapsed: round.target + 0.4 });

  const res = a.last('result');
  const ann = res.standings.find(s => s.name === 'Ann');
  const bob = res.standings.find(s => s.name === 'Bob');
  check('불가능한 제출은 DNF', ann && ann.dnf, JSON.stringify(ann));
  check('정직한 쪽이 이김', bob && bob.rank === 1, JSON.stringify(bob));
  check('DNF에게는 점수 없음', res.roster.find(p => p.id === 'a').points === 0);

  // 한 라운드에 두 번은 못 낸다.
  const r2 = openRoom();
  const x = await r2.join('x', 'X');
  await r2.send(x, { t: 'start' });
  const rd = x.last('round');
  NOW = rd.startAt + (rd.target + 0.5) * 1000 + 20;
  await r2.send(x, { t: 'stop', roundId: rd.roundId, elapsed: rd.target + 0.5 });
  const first = x.last('result').standings[0].elapsed;
  await r2.send(x, { t: 'stop', roundId: rd.roundId, elapsed: rd.target });
  check('두 번째 제출 무시', x.last('result').standings[0].elapsed === first);
}

console.log('\n마감');
{
  const r = openRoom();
  const a = await r.join('a', 'Ann');
  const b = await r.join('b', 'Bob');
  await r.send(a, { t: 'start' });
  const round = a.last('round');

  NOW = round.startAt + (round.target + 0.1) * 1000 + 20;
  await r.send(a, { t: 'stop', roundId: round.roundId, elapsed: round.target + 0.1 });
  check('한 명이 안 냈으면 안 끝남', !a.last('result'));

  // Bob이 끝내 안 낸다. 마감이 되면 알람이 라운드를 닫는다.
  NOW = round.deadline;
  await r.room.alarm();

  const res = a.last('result');
  check('마감에 라운드가 닫힘', !!res);
  check('안 낸 사람은 DNF', res && res.standings.find(s => s.name === 'Bob').dnf);
  check('낸 사람이 이김', res && res.standings[0].name === 'Ann');
}

console.log('\n이탈 · 재접속');
{
  const r = openRoom();
  const a = await r.join('a', 'Ann');
  const b = await r.join('b', 'Bob');
  const c = await r.join('c', 'Cat');

  // 방장이 나가면 남은 사람 중 가장 먼저 들어온 사람이 이어받는다.
  await r.room.webSocketClose(a);
  check('방장 승계', b.last('roster').hostId === 'b', b.last('roster').hostId);
  check('로스터에서 빠짐', b.last('roster').roster.length === 2);

  // 나간 사람을 기다리느라 라운드가 멈추면 안 된다.
  await r.send(b, { t: 'start' });
  const round = b.last('round');
  NOW = round.startAt + (round.target + 0.1) * 1000 + 20;
  await r.send(b, { t: 'stop', roundId: round.roundId, elapsed: round.target + 0.1 });
  check('아직 Cat을 기다림', !b.last('result'));
  await r.room.webSocketClose(c);
  check('남은 사람이 다 냈으면 바로 닫힘', !!b.last('result'));

  // 새로고침하고 돌아오면 자리와 점수를 이어받는다.
  const pts = b.last('result').roster.find(p => p.id === 'b').points;
  const again = await r.join('b', 'Bob');
  check('점수 유지', again.last('welcome').roster.find(p => p.id === 'b').points === pts,
        `${pts}`);
}

console.log('\n정원 · 잡음');
{
  const r = openRoom();
  for (let i = 0; i < MAX_PLAYERS; i++) await r.join('p' + i, 'P' + i);
  const over = await r.join('over', 'Over');
  check('정원이 차면 거절', over.last('error') && over.last('error').reason === 'full',
        JSON.stringify(over.last('error')));
  check('정원 유지', over.last('error') && !over.last('welcome'));

  // 말이 안 되는 입력에 죽지 않아야 한다.
  const r2 = openRoom();
  const x = await r2.join('x', 'X');
  const before = x.sent.length;
  await r2.room.webSocketMessage(x, 'not json');
  await r2.room.webSocketMessage(x, JSON.stringify({ t: 'stop' }));
  await r2.room.webSocketMessage(x, JSON.stringify({ nope: 1 }));
  await r2.room.webSocketMessage(x, 'x'.repeat(5000));
  check('잡음에 응답하지 않음', x.sent.length === before, `${x.sent.length} vs ${before}`);

  // hello 없이 온 소켓
  const ghost = new FakeWS();
  r2.ctx.acceptWebSocket(ghost);
  await r2.room.webSocketMessage(ghost, JSON.stringify({ t: 'start' }));
  check('hello 먼저 요구', ghost.last('error') && ghost.last('error').reason === 'hello first');

  // ping은 저장 없이 바로 답한다.
  await r2.room.webSocketMessage(x, JSON.stringify({ t: 'ping', c: 12345 }));
  const pong = x.last('pong');
  check('pong이 내 시각을 되돌려줌', pong && pong.c === 12345);
  check('pong이 서버 시각을 줌', pong && pong.s === NOW);
}

console.log('\n방 수명');
{
  const r = openRoom();
  const a = await r.join('a', 'Ann');
  check('저장돼 있음', r.ctx.map.has('state'));

  // 아무도 없고 조용해지면 정리된다.
  await r.room.webSocketClose(a);
  r.ctx.sockets.length = 0;
  NOW += IDLE_MS + 1;
  await r.room.alarm();
  check('빈 방은 지워짐', !r.ctx.map.has('state'));
}

console.log('\n방 코드 예약');
{
  const r = openRoom();
  const first = await r.room.fetch(new Request('https://room/claim'));
  check('빈 방은 잡힘', (await first.json()).ok === true);

  const second = await r.room.fetch(new Request('https://room/claim'));
  check('방금 잡힌 코드는 다시 안 나옴', (await second.json()).ok === false);
}

Date.now = realNow;
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
