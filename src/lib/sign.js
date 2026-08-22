// 런 토큰 서명.
//
// WebCrypto만 쓴다. 워커에도 노드에도 전역으로 있어서, 테스트가 워커
// 런타임을 띄우지 않고 이 파일을 그대로 import할 수 있다. node:crypto를
// 쓰면 그게 깨진다.

const enc = new TextEncoder();

async function hmacKey(secret){
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']
  );
}

// base64url. 토큰이 JSON에도 URL에도 그대로 들어간다.
function b64url(bytes){
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

export async function sign(secret, payload){
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload));
  return b64url(new Uint8Array(sig));
}

// 비교 시간이 내용에 따라 달라지지 않게 XOR을 끝까지 누적한다. 첫 글자가
// 틀렸을 때 바로 false를 주면, 응답 시간 차이로 서명을 한 글자씩 맞춰
// 나갈 수 있다.
export async function verify(secret, payload, token){
  const expect = await sign(secret, payload);
  if (typeof token !== 'string' || token.length !== expect.length) return false;
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
