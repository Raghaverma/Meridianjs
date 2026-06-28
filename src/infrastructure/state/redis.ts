import type { StateStorage } from "../../core/types.js";

/** Minimal interface satisfied by ioredis, node-redis, and most Redis clients. */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export class RedisStateStorage implements StateStorage {
  constructor(private readonly client: RedisLikeClient) {}

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    await this.client.set(key, value);
    if (ttlSeconds != null) {
      await this.client.expire(key, ttlSeconds);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}
