import type { StateStorage } from "../core/types.js";

/** Minimal interface satisfied by @upstash/redis Redis client. */
export interface UpstashRedisClient {
  get<T = string>(key: string): Promise<T | null>;
  set(key: string, value: string, opts?: { ex?: number }): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

export class UpstashStateStorage implements StateStorage {
  constructor(private readonly client: UpstashRedisClient) {}

  async get(key: string): Promise<string | null> {
    const value = await this.client.get<string>(key);
    return value ?? null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    await this.client.set(key, value, ttlSeconds != null ? { ex: ttlSeconds } : undefined);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}
