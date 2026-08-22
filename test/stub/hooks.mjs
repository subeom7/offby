// cloudflare:workers 를 위 대역으로 돌린다. 이게 있어야 워커 런타임 없이
// 노드에서 src/room.js를 그대로 import할 수 있다.
//
// import.meta.url 이 이미 file:// URL이라 경로 변환이 필요 없다.

const STUB = new URL('./workers.mjs', import.meta.url).href;

export function resolve(specifier, context, next){
  if (specifier === 'cloudflare:workers')
    return { url: STUB, shortCircuit: true };
  return next(specifier, context);
}
