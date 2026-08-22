// 방 하나 = Durable Object 하나. 이름이 곧 방 코드다.
//
// WebSocket Hibernation API를 쓴다. 사람들이 방에 들어와 놓고 한참 아무
// 것도 안 하는 게 이 게임의 정상적인 모습인데, 그 동안 객체가 메모리에
// 떠 있을 이유가 없다. 연결은 런타임이 들고 있고 메시지가 올 때만 깨어난다.
//
// 프로토콜을 얇게 유지하는 이유: **WebSocket 메시지 하나가 DO 요청 하나로
// 과금된다.** 무료 티어가 하루 10만이라, 위치를 실시간으로 흘려보내는
// 식의 설계는 여기서 바로 예산을 태운다. 라운드당 1인 3메시지로 맞춰 뒀다.

import { DurableObject } from 'cloudflare:workers';
import { pickTarget } from './lib/run.js';
import {
  MAX_PLAYERS, COUNTDOWN_MS, IDLE_MS,
  arrivalOk, roundDeadline, standingsOf, awardPoints, nextHost,
} from './lib/room-logic.js';
import { cleanNickname } from './lib/ids.js';

const MAX_MSG = 2 * 1024;

const fresh = () => ({
  players: {},        // id -> {id, name, joinedAt, points}
  hostId: null,
  roundNo: 0,
  round: null,        // {roundId, target, startAt, deadline, submissions}
  lastTarget: 0,
  claimedAt: 0,
  lastSeen: 0,
});

export class Room extends DurableObject {
  #state = null;

  async #load(){
    if (!this.#state) this.#state = (await this.ctx.storage.get('state')) || fresh();
    return this.#state;
  }

  async #save(){
    this.#state.lastSeen = Date.now();
    await this.ctx.storage.put('state', this.#state);
    await this.#scheduleAlarm();
  }

  // 알람은 하나뿐이라 라운드 마감과 방 정리를 같이 태운다. 둘 중 먼저
  // 올 시각에 맞춰 두고, 깨어나서 무엇이 걸렸는지 본다.
  async #scheduleAlarm(){
    const s = this.#state;
    const idleAt = s.lastSeen + IDLE_MS;
    const at = s.round ? Math.min(s.round.deadline, idleAt) : idleAt;
    await this.ctx.storage.setAlarm(at);
  }

  async fetch(request){
    const url = new URL(request.url);
    const s = await this.#load();

    // 워커가 새 방 코드를 잡을 때 쓴다. 사람이 아직 안 들어온 방이라도
    // 방금 발급된 코드를 다시 내주면 안 되므로 예약 시각을 본다.
    if (url.pathname === '/claim'){
      const now = Date.now();
      const taken = Object.keys(s.players).length > 0 || now - s.claimedAt < 2 * 60 * 1000;
      if (taken) return Response.json({ ok: false });
      s.claimedAt = now;
      await this.#save();
      return Response.json({ ok: true });
    }

    if (url.pathname === '/ws'){
      if (request.headers.get('Upgrade') !== 'websocket')
        return new Response('expected websocket', { status: 426 });

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('not found', { status: 404 });
  }

  // ── 메시지 ──────────────────────────────

  async webSocketMessage(ws, raw){
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return;

    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    const s = await this.#load();

    // 시계 보정. 저장할 게 없으니 여기서 바로 끝낸다.
    if (m.t === 'ping'){
      ws.send(JSON.stringify({ t: 'pong', c: m.c, s: Date.now() }));
      return;
    }

    if (m.t === 'hello') return this.#hello(ws, s, m);

    const who = this.#whoIs(ws);
    if (!who) return this.#say(ws, 'error', { reason: 'hello first' });

    if (m.t === 'start') return this.#start(s, who);
    if (m.t === 'stop')  return this.#stop(s, who, m);
    if (m.t === 'bye')   return this.#drop(s, who);
  }

  #whoIs(ws){
    const a = ws.deserializeAttachment();
    return a && a.id ? a.id : null;
  }

  #say(ws, t, body){
    try { ws.send(JSON.stringify({ t, ...body })); } catch { /* 끊긴 소켓 */ }
  }

  #broadcast(t, body){
    const msg = JSON.stringify({ t, ...body });
    for (const ws of this.ctx.getWebSockets()){
      try { ws.send(msg); } catch { /* 끊긴 소켓 */ }
    }
  }

  #snapshot(s){
    const roster = Object.values(s.players)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map(p => ({ id: p.id, name: p.name, points: p.points || 0 }));
    return { roster, hostId: s.hostId, roundNo: s.roundNo };
  }

  #roundView(s){
    if (!s.round) return null;
    const { roundId, target, startAt, deadline } = s.round;
    return { roundId, target, startAt, deadline, serverNow: Date.now() };
  }

  async #hello(ws, s, m){
    const id = typeof m.id === 'string' && m.id.length <= 64 ? m.id : null;
    if (!id) return this.#say(ws, 'error', { reason: 'id' });

    const known = s.players[id];
    if (!known && Object.keys(s.players).length >= MAX_PLAYERS)
      return this.#say(ws, 'error', { reason: 'full' });

    // 새로고침하고 돌아온 사람은 자리와 점수를 그대로 이어받는다.
    s.players[id] = {
      id,
      name: cleanNickname(m.name, known ? known.name : 'anon'),
      joinedAt: known ? known.joinedAt : Date.now(),
      points: known ? known.points : 0,
    };
    if (!s.hostId) s.hostId = id;

    // 소켓에 붙여 둔다. 하이버네이션에서 깨어나도 이 소켓이 누구인지 안다.
    ws.serializeAttachment({ id });
    await this.#save();

    this.#say(ws, 'welcome', { you: id, ...this.#snapshot(s), round: this.#roundView(s) });
    this.#broadcast('roster', this.#snapshot(s));
  }

  async #start(s, who){
    if (who !== s.hostId) return;
    if (s.round) return;                       // 진행 중이면 무시

    const target = pickTarget(s.lastTarget);
    const startAt = Date.now() + COUNTDOWN_MS;

    s.roundNo += 1;
    s.lastTarget = target;
    s.round = {
      roundId: s.roundNo,
      target,
      startAt,
      deadline: roundDeadline(startAt, target),
      submissions: {},
    };
    await this.#save();

    this.#broadcast('round', this.#roundView(s));
  }

  async #stop(s, who, m){
    const r = s.round;
    if (!r || m.roundId !== r.roundId) return;
    if (r.submissions[who]) return;            // 한 라운드에 한 번

    const elapsed = m.elapsed;
    const sane = typeof elapsed === 'number' && isFinite(elapsed)
              && elapsed > 0 && elapsed < r.target * 4 + 10;

    r.submissions[who] = {
      elapsed: sane ? elapsed : 0,
      ok: sane && arrivalOk({ startAt: r.startAt, elapsed, arrivedAt: Date.now() }),
    };
    await this.#save();

    // 아직 안 낸 사람이 있으면 기다린다. 없으면 바로 끝낸다 — 마감까지
    // 굳이 붙잡고 있을 이유가 없다.
    const waiting = Object.keys(s.players).some(id => !r.submissions[id]);
    if (waiting) this.#broadcast('submitted', { id: who, count: Object.keys(r.submissions).length });
    else await this.#resolve(s);
  }

  async #resolve(s){
    const r = s.round;
    if (!r) return;

    const players = Object.values(s.players).sort((a, b) => a.joinedAt - b.joinedAt);
    const standings = standingsOf({ target: r.target, submissions: r.submissions, players });

    const scores = awardPoints(standings, Object.fromEntries(players.map(p => [p.id, p.points || 0])));
    for (const p of players) p.points = scores[p.id] || 0;

    s.round = null;
    await this.#save();

    this.#broadcast('result', { target: r.target, standings, ...this.#snapshot(s) });
  }

  async #drop(s, who){
    if (!s.players[who]) return;
    delete s.players[who];
    if (s.hostId === who) s.hostId = nextHost(Object.values(s.players), who);
    await this.#save();
    this.#broadcast('roster', this.#snapshot(s));

    // 나간 사람을 기다리느라 라운드가 멈춰 있으면 안 된다.
    if (s.round && Object.keys(s.players).length
        && Object.keys(s.players).every(id => s.round.submissions[id]))
      await this.#resolve(s);
  }

  async webSocketClose(ws){
    const who = this.#whoIs(ws);
    if (!who) return;
    await this.#drop(await this.#load(), who);
  }

  async webSocketError(ws){
    return this.webSocketClose(ws);
  }

  async alarm(){
    const s = await this.#load();
    const now = Date.now();

    if (s.round && now >= s.round.deadline) await this.#resolve(s);

    // 아무도 없고 조용하면 방을 지운다. 남겨 둘 이유가 없다.
    if (now - s.lastSeen >= IDLE_MS && !this.ctx.getWebSockets().length){
      await this.ctx.storage.deleteAll();
      this.#state = null;
      return;
    }
    await this.#scheduleAlarm();
  }
}
