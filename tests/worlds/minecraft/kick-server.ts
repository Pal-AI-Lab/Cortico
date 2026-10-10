/**
 * 本机协议服务器(minecraft-protocol 的服务端实现),只监听 127.0.0.1 的随机端口。
 * 端口能建立 TCP 连接,登录时按给定理由把客户端断开,用来复现「端口可达但进不了世界」。
 */
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

const req = createRequire(createRequire(import.meta.url).resolve('mineflayer/package.json'));
const mc = req('minecraft-protocol') as {
  createServer(opts: Record<string, unknown>): KickServerHandle;
};
const nbt = req('prismarine-nbt') as {
  comp(value: Record<string, unknown>): unknown;
  string(value: string): unknown;
};

interface ServerClient {
  end(reason: string, fullReason?: unknown): void;
  prependOnceListener(event: string, fn: () => void): void;
}

interface KickServerHandle {
  socketServer: { address(): AddressInfo };
  on(event: 'listening', fn: () => void): void;
  on(event: 'connection' | 'playerJoin', fn: (client: ServerClient) => void): void;
  close(): void;
}

export interface KickServer {
  port: number;
  close(): void;
}

/**
 * `login`:登录阶段按 JSON 文本理由断开(白名单、版本、认证都在这一步);
 * `play`:登录成功、进入游戏阶段后按 NBT 组件理由断开。
 */
export async function kickServer(at: 'login' | 'play', reason: Record<string, unknown>): Promise<KickServer> {
  const server = mc.createServer({ 'online-mode': false, version: '1.20.6', port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.on('listening', resolve));
  if (at === 'login') {
    // 抢在服务端自己的登录处理之前断开,客户端收到的是登录阶段的 disconnect 包
    server.on('connection', (client) => {
      client.prependOnceListener('login_start', () => client.end('', JSON.stringify(reason)));
    });
  } else {
    server.on('playerJoin', (client) => {
      const text = typeof reason.text === 'string' ? reason.text : JSON.stringify(reason);
      client.end('', nbt.comp({ text: nbt.string(text) }));
    });
  }
  return { port: server.socketServer.address().port, close: () => server.close() };
}
