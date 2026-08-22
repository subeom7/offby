// 새로 붙인 화면(모드 전환 · 기록 도전 · 순위표 · 방)을 jsdom에서 검증한다.
//
//     npm run test:client
//
// game.test.mjs 는 손대지 않는다 — 그쪽은 "솔로 게임이 예전 그대로인가"를
// 지키는 파일이고, 여기는 그 위에 얹은 것들을 본다.
//
// fetch와 WebSocket을 대역으로 넣는다. 진짜로 물어보려는 건 네트워크가
// 아니라 **화면이 서버 응답에 어떻게 반응하는가**다.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(HERE, "..", "public", "index.html"), "utf8");

const problems = [];
let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [o] ${name}`); }
  else { fail++; console.log(`  [X] ${name}  ${detail}`); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 열린 세션 하나. routes로 /api/* 응답을 정해 준다.
function open({ url = "https://offby.dev/", routes = {}, sockets = [], store = null } = {}) {
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => problems.push("jsdomError: " + (e.stack || e.message)));

  const dom = new JSDOM(HTML, {
    runScripts: "dangerously",
    url,
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      let t = 0;
      w.performance.now = () => t;
      w.__advance = ms => { t += ms; };
      if (store) for (const [k, v] of Object.entries(store)) w.localStorage.setItem(k, v);

      w.__calls = [];
      w.fetch = async (path, init) => {
        w.__calls.push({ path, body: init && init.body ? JSON.parse(init.body) : null });
        const hit = routes[String(path).split("?")[0]] ?? routes[String(path)];
        if (hit === undefined) return { ok: false, status: 503, json: async () => ({}) };
        if (hit instanceof Error) throw hit;
        return { ok: true, status: 200, json: async () => hit };
      };

      // 소켓은 만들어진 순서대로 sockets 배열에 담아 테스트가 조종한다.
      w.WebSocket = function (wsUrl) {
        this.url = wsUrl;
        this.readyState = 1;
        this.sent = [];
        this.send = s => this.sent.push(JSON.parse(s));
        this.close = () => { this.readyState = 3; };
        // 서버가 보낸 척
        this.deliver = m => this.onmessage && this.onmessage({ data: JSON.stringify(m) });
        sockets.push(this);
        setTimeout(() => this.onopen && this.onopen(), 0);
      };

      w.addEventListener("error", e => problems.push("window.error: " + (e.error?.stack || e.message)));
    },
  });
  return dom;
}

const $ = (d, id) => d.getElementById(id);
const shown = (d, id) => !$(d, id).hidden;

console.log("\n" + "=".repeat(60));
console.log("i18n 키 커버리지");
console.log("=".repeat(60));
{
  // 문구가 배로 늘어난 변경이라, 한쪽에만 키를 추가하는 실수가 가장 잦다.
  // 화면을 다 눌러 보지 않으면 안 드러나므로 여기서 통째로 비교한다.
  const src = HTML.slice(HTML.indexOf("const I18N"), HTML.indexOf("const $ = id"));
  const half = src.indexOf("ko: {");
  const enKeys = new Set([...src.slice(0, half).matchAll(/^\s{6}([a-zA-Z]+):/gm)].map(m => m[1]));
  const koKeys = new Set([...src.slice(half).matchAll(/^\s{6}([a-zA-Z]+):/gm)].map(m => m[1]));

  const missingKo = [...enKeys].filter(k => !koKeys.has(k));
  const missingEn = [...koKeys].filter(k => !enKeys.has(k));
  check("키를 뽑아냄", enKeys.size > 40, `${enKeys.size}개`);
  check("한국어에 빠진 키 없음", missingKo.length === 0, missingKo.join(","));
  check("영어에 빠진 키 없음", missingEn.length === 0, missingEn.join(","));
}

console.log("\n" + "=".repeat(60));
console.log("모드 전환");
console.log("=".repeat(60));
{
  const dom = open();
  const d = dom.window.document;

  check("기본은 연습", $(d, "m-practice").getAttribute("aria-selected") === "true");
  check("연습에 계측기 보임", shown(d, "readout") && shown(d, "pad") && shown(d, "stats"));
  check("연습에 순위판 숨김", !shown(d, "panel-ranks") && !shown(d, "panel-room"));

  $(d, "m-room").click();
  check("방 탭 선택됨", $(d, "m-room").getAttribute("aria-selected") === "true");
  check("방 판 보임", shown(d, "panel-room"));
  check("입장 전엔 계측기 숨김", !shown(d, "readout") && !shown(d, "pad"));
  check("입장 폼 보임", !$(d, "room-join").hidden);

  $(d, "m-practice").click();
  check("연습으로 복귀", shown(d, "readout") && !shown(d, "panel-room"));
  check("탭 표시도 복귀", $(d, "m-practice").getAttribute("aria-selected") === "true");

  // 계측기는 순위 탭에서만 통째로 사라진다.
  $(d, "m-ranks").click();
  check("순위에서 계측기 숨김", !shown(d, "readout") && !shown(d, "pad") && !shown(d, "stats"));
  check("순위판 보임", shown(d, "panel-ranks"));
}

console.log("\n" + "=".repeat(60));
console.log("순위표");
console.log("=".repeat(60));
{
  const board = {
    scope: "today",
    board: [
      { rank: 1, nickname: "minji", avgError: 0.038, rounds: 10, at: 1 },
      { rank: 2, nickname: "subeom", avgError: 0.041, rounds: 10, at: 2 },
    ],
  };
  const dom = open({ routes: { "/api/board": board } });
  const d = dom.window.document;

  $(d, "m-ranks").click();
  await sleep(20);

  const rows = d.querySelectorAll("#board table tr");
  check("머리글 + 두 줄", rows.length === 3, String(rows.length));
  check("1위 이름", d.querySelector("#board table tr:nth-child(2) .who")?.textContent === "minji",
        d.querySelector("#board table tr:nth-child(2) .who")?.textContent);
  check("오차 표시", d.querySelector("#board table tr:nth-child(2) .v")?.textContent === "0.038s",
        d.querySelector("#board table tr:nth-child(2) .v")?.textContent);
  check("오늘이 기본", $(d, "b-today").getAttribute("aria-selected") === "true");

  $(d, "b-all").click();
  await sleep(20);
  check("전체 탭 선택", $(d, "b-all").getAttribute("aria-selected") === "true");
  check("전체 scope로 요청", dom.window.__calls.some(c => String(c.path).includes("scope=all")),
        JSON.stringify(dom.window.__calls.map(c => c.path)));

  // 닉네임은 남이 넣은 문자열이다. 표에 태그로 들어가면 안 된다.
  const evil = { scope: "all", board: [{ rank: 1, nickname: "<img src=x onerror=alert(1)>", avgError: 0.1, rounds: 10, at: 1 }] };
  const dom2 = open({ routes: { "/api/board": evil } });
  const d2 = dom2.window.document;
  $(d2, "m-ranks").click();
  await sleep(20);
  check("닉네임이 태그로 안 들어감", d2.querySelectorAll("#board img").length === 0);
  // .who 는 머리글 칸에도 붙는다(정렬용). 데이터 칸만 본다.
  check("닉네임은 글자로만", d2.querySelector("#board td.who")?.textContent.includes("<img"),
        d2.querySelector("#board td.who")?.textContent);
}

console.log("\n" + "=".repeat(60));
console.log("순위표 · 서버가 없을 때");
console.log("=".repeat(60));
{
  const dom = open({ routes: {} });          // 모든 요청이 503
  const d = dom.window.document;
  $(d, "m-ranks").click();
  await sleep(20);
  check("안내 문구로 대체", $(d, "board").textContent.includes("unavailable"),
        $(d, "board").textContent);
  check("게임은 그대로 됨", !!$(d, "pad"));
}

console.log("\n" + "=".repeat(60));
console.log("기록 도전");
console.log("=".repeat(60));
{
  const targets = [3, 5, 2, 7, 4, 9, 6, 8, 3, 5];
  const dom = open({
    routes: {
      "/api/run/start": { runId: "r1", targets, issuedAt: 1000, token: "tok", rounds: 10 },
      "/api/run/finish": { avgError: 0.042, flagged: false, rank: { today: 3, all: 11 }, nickname: "me" },
    },
  });
  const w = dom.window, d = w.document;

  $(d, "m-ranked").click();
  await sleep(20);

  check("서버에서 목표를 받음", w.__calls.some(c => c.path === "/api/run/start"));
  check("첫 목표가 서버 것", parseFloat($(d, "target").textContent) === targets[0],
        $(d, "target").textContent);
  check("진행률 칸으로 바뀜", $(d, "s-streak").textContent === "0/10",
        $(d, "s-streak").textContent);

  // 열 번 친다. 매번 서버가 준 순서대로 목표가 나와야 한다.
  let sameOrder = true;
  for (let i = 0; i < 10; i++) {
    if (parseFloat($(d, "target").textContent) !== targets[i]) sameOrder = false;
    $(d, "pad").click();
    w.__advance((targets[i] + 0.04) * 1000);
    $(d, "pad").click();
    await sleep(750);
  }
  check("목표 순서가 서버와 같음", sameOrder);
  check("열 번 뒤 제출 화면", shown(d, "panel-run"), "panel-run hidden");
  check("계측기는 접힘", !shown(d, "readout"));
  check("평균이 먼저 보임", $(d, "run-result").textContent.includes("0.04"),
        $(d, "run-result").textContent);

  $(d, "run-nick").value = "me";
  $(d, "run-submit").click();
  await sleep(20);

  const sub = w.__calls.find(c => c.path === "/api/run/finish");
  check("제출됨", !!sub);
  check("시도 10개를 보냄", sub && sub.body.attempts.length === 10, sub && sub.body.attempts.length);
  check("토큰을 그대로 돌려줌", sub && sub.body.token === "tok");
  check("목표를 그대로 돌려줌", sub && JSON.stringify(sub.body.targets) === JSON.stringify(targets));
  check("닉네임을 보냄", sub && sub.body.nickname === "me", sub && sub.body.nickname);
  check("등수 표시", $(d, "run-result").textContent.includes("3"),
        $(d, "run-result").textContent);
  check("이름이 저장됨", JSON.parse(w.localStorage.getItem("offby/me")).name === "me");
}

console.log("\n" + "=".repeat(60));
console.log("기록 도전 · 서버가 없을 때");
console.log("=".repeat(60));
{
  const dom = open({ routes: {} });
  const d = dom.window.document;
  $(d, "m-ranked").click();
  await sleep(20);

  // 여기서 막히면 게임 자체를 못 하게 된다. 조용히 연습으로 떨어져야 한다.
  check("연습으로 떨어짐", $(d, "m-practice").getAttribute("aria-selected") === "true");
  check("계측기가 살아 있음", shown(d, "readout") && shown(d, "pad"));
  check("이유를 알려줌", $(d, "verdict").textContent.includes("connection"),
        $(d, "verdict").textContent);

  $(d, "pad").click();
  dom.window.__advance(3000);
  $(d, "pad").click();
  check("그대로 플레이됨", $(d, "s-count").textContent === "1", $(d, "s-count").textContent);
}

console.log("\n" + "=".repeat(60));
console.log("방");
console.log("=".repeat(60));
{
  const sockets = [];
  const dom = open({ routes: { "/api/room": { code: "AB2C" } }, sockets });
  const w = dom.window, d = w.document;

  $(d, "m-room").click();
  $(d, "nick").value = "Ann";
  $(d, "room-create").click();
  await sleep(20);

  check("소켓 하나 열림", sockets.length === 1, String(sockets.length));
  check("방 코드로 접속", sockets[0] && sockets[0].url.includes("/api/room/AB2C/ws"),
        sockets[0] && sockets[0].url);
  check("URL이 방 링크로 바뀜", w.location.pathname === "/r/AB2C", w.location.pathname);
  check("코드가 보임", $(d, "room-code-out").textContent === "AB2C");

  const ws = sockets[0];
  check("hello를 보냄", ws.sent.some(m => m.t === "hello" && m.name === "Ann"),
        JSON.stringify(ws.sent));
  check("시계 보정 ping을 보냄", ws.sent.filter(m => m.t === "ping").length === 5,
        String(ws.sent.filter(m => m.t === "ping").length));

  // 서버가 맞이한다.
  ws.deliver({
    t: "welcome", you: "me", hostId: "me", roundNo: 0, round: null,
    roster: [{ id: "me", name: "Ann", points: 0 }],
  });
  check("계측기가 나타남", shown(d, "readout") && shown(d, "pad"));
  check("로스터에 내가 있음", $(d, "roster").textContent.includes("Ann"));
  check("방장이라 시작 버튼", $(d, "pad").textContent === "Start round", $(d, "pad").textContent);

  // 둘째가 들어온다.
  ws.deliver({
    t: "roster", hostId: "me", roundNo: 0,
    roster: [{ id: "me", name: "Ann", points: 0 }, { id: "b", name: "Bob", points: 0 }],
  });
  check("로스터 갱신", $(d, "roster").children.length === 2, String($(d, "roster").children.length));
  check("인원이 표시됨", $(d, "room-meta").textContent.includes("2"), $(d, "room-meta").textContent);

  // 방장이 라운드를 연다.
  $(d, "pad").click();
  check("start를 보냄", ws.sent.some(m => m.t === "start"));

  // 서버가 라운드를 알린다. startAt은 이미 지난 시각으로 줘서 카운트다운을
  // 건너뛰고 바로 시작되게 한다.
  ws.deliver({
    t: "round", roundId: 1, target: 5,
    startAt: Date.now() - 10, deadline: Date.now() + 11000, serverNow: Date.now(),
  });
  check("목표가 서버 것", parseFloat($(d, "target").textContent) === 5,
        $(d, "target").textContent);
  await sleep(180);
  check("카운트다운 뒤 측정 시작", $(d, "pad").textContent === "Stop", $(d, "pad").textContent);

  w.__advance(5040);
  $(d, "pad").click();
  const stop = ws.sent.find(m => m.t === "stop");
  check("stop을 보냄", !!stop, JSON.stringify(ws.sent.slice(-3)));
  check("측정값을 보냄", stop && Math.abs(stop.elapsed - 5.04) < 0.001, stop && stop.elapsed);
  check("라운드 번호를 붙임", stop && stop.roundId === 1);
  check("다른 사람을 기다림", $(d, "pad").textContent.includes("Waiting"), $(d, "pad").textContent);

  // 결과가 온다.
  ws.deliver({
    t: "result", target: 5, hostId: "me", roundNo: 1,
    roster: [{ id: "me", name: "Ann", points: 1 }, { id: "b", name: "Bob", points: 0 }],
    standings: [
      { id: "me", name: "Ann", elapsed: 5.04, error: 0.04, dnf: false, rank: 1 },
      { id: "b", name: "Bob", elapsed: 5.3, error: 0.3, dnf: false, rank: 2 },
    ],
  });
  check("라운드 순위 표시", $(d, "room-board").textContent.includes("Ann"));
  check("오차 부호 표시", $(d, "room-board").textContent.includes("+0.040"),
        $(d, "room-board").textContent);
  check("승자 문구", $(d, "room-note").textContent.includes("Ann"), $(d, "room-note").textContent);
  check("점수 반영", $(d, "roster").textContent.includes("1"));
  check("다음 라운드 준비", $(d, "pad").textContent === "Start round", $(d, "pad").textContent);

  // 기록계에도 남는다 — 방에서 친 것도 내가 친 것이다.
  check("솔로 기록에도 쌓임", $(d, "s-count").textContent === "1", $(d, "s-count").textContent);

  // 탭을 떠나면 자리를 비운다.
  $(d, "m-practice").click();
  check("bye를 보냄", ws.sent.some(m => m.t === "bye"));
  check("소켓 닫음", ws.readyState === 3);
  check("URL 복구", w.location.pathname === "/", w.location.pathname);
}

console.log("\n" + "=".repeat(60));
console.log("방 링크로 들어온 경우");
console.log("=".repeat(60));
{
  // 이름이 없으면 코드만 채워 두고 입장 폼을 보여 준다.
  const s1 = [];
  const d1 = open({ url: "https://offby.dev/r/XY45", sockets: s1 }).window.document;
  check("방 탭으로 열림", $(d1, "m-room").getAttribute("aria-selected") === "true");
  check("코드가 채워짐", $(d1, "room-code-in").value === "XY45", $(d1, "room-code-in").value);
  check("이름이 없으면 안 들어감", s1.length === 0, String(s1.length));

  // 이름을 이미 정해 둔 사람은 링크만 누르면 바로 들어간다.
  const s2 = [];
  const d2 = open({
    url: "https://offby.dev/r/XY45",
    sockets: s2,
    store: { "offby/me": JSON.stringify({ id: "u1", name: "Ann" }) },
  }).window.document;
  check("이름이 있으면 바로 입장", s2.length === 1, String(s2.length));
  check("그 방으로 접속", s2[0] && s2[0].url.includes("/api/room/XY45/ws"), s2[0] && s2[0].url);
  check("입장 폼 대신 방 화면", $(d2, "room-join").hidden && !$(d2, "room-live").hidden);

  // 링크는 사람이 손으로 고쳐 치기도 한다.
  const s3 = [];
  const d3 = open({ url: "https://offby.dev/r/xy45", sockets: s3 }).window.document;
  check("소문자 코드도 대문자로", $(d3, "room-code-in").value === "XY45", $(d3, "room-code-in").value);
}

console.log("\n" + "=".repeat(60));
console.log(`런타임 오류: ${problems.length ? "\n  " + problems.join("\n  ") : "없음"}`);
console.log(`통과 ${pass} / 실패 ${fail}`);
console.log("=".repeat(60));
process.exit(fail || problems.length ? 1 : 0);
