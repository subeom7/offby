// cloudflare:workers 의 대역. Room이 상속하는 것만 있으면 된다.
export class DurableObject {
  constructor(ctx, env){ this.ctx = ctx; this.env = env; }
}
