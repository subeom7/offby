// 방 코드 · 닉네임 · 플레이어 식별자.

import { sign } from './sign.js';

// 방 코드는 사람이 목소리로 불러 주는 값이다. 0/O, 1/I를 뺀다.
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;

export function makeRoomCode(){
  // 알파벳이 32자라 256이 정확히 나눠떨어진다 — 모듈로 편향이 없다.
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

export function isRoomCode(s){
  return typeof s === 'string'
      && s.length === CODE_LENGTH
      && [...s].every(c => CODE_ALPHABET.includes(c));
}

export const NICK_MAX = 16;

// 순위표는 여러 사람의 이름이 세로로 늘어선 표다. 제어문자나 방향 전환
// 문자(U+202E 등)가 하나 끼면 그 아래 줄들이 통째로 뒤집혀 보인다.
// 서버에서 턴다 — 클라이언트를 믿을 수 없다.
// 코드포인트 범위로 적는다. 이 문자들은 소스에 그대로 써 두면 보이지
// 않아서, 나중에 읽는 사람이 무엇이 걸러지는지 알 수 없다.
const UNSAFE_RANGES = [
  [0x0000, 0x001f],   // C0 제어문자
  [0x007f, 0x009f],   // DEL + C1 제어문자
  [0x200b, 0x200f],   // 폭 없는 공백, LRM/RLM
  [0x202a, 0x202e],   // 방향 재정의 (U+202E가 뒷줄을 뒤집는 그것)
  [0x2066, 0x2069],   // 방향 격리
];

function isUnsafe(cp){
  return UNSAFE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

export function cleanNickname(raw, fallback = 'anon'){
  if (typeof raw !== 'string') return fallback;
  const kept = [...raw].filter(ch => !isUnsafe(ch.codePointAt(0))).join('');
  // slice는 코드유닛 단위라 이모지가 반쪽으로 잘릴 수 있다. 글자 단위로 센다.
  const s = [...kept.replace(/\s+/g, ' ').trim()].slice(0, NICK_MAX).join('');
  return s || fallback;
}

// 기기 ID는 클라이언트가 만든 UUID다. 그대로 저장하면 나중에 다른 데서
// 새어 나온 식별자와 이어 붙일 수 있으므로, 서버 비밀키로 한 번 더
// 해시해서 넣는다. 이 저장본만으로는 원본 UUID를 되돌릴 수 없다.
export async function playerHash(secret, playerId){
  return (await sign(secret, 'player:' + String(playerId))).slice(0, 22);
}

// 일간 보드의 하루. UTC 자정에 리셋된다.
export function utcDay(now = Date.now()){
  return new Date(now).toISOString().slice(0, 10);
}
