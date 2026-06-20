import type { StateStorage } from "../core/types.js";

export class SharedCooldownManager {
  constructor(
    private readonly storage: StateStorage,
    private readonly keyPrefix = "meridian:cooldown:",
  ) {}

  private key(provider: string): string {
    return `${this.keyPrefix}${provider}`;
  }

  async recordCooldown(provider: string, retryAfterSeconds: number): Promise<void> {
    if (retryAfterSeconds <= 0) return;
    const expiryMs = Date.now() + retryAfterSeconds * 1000;
    await this.storage.set(this.key(provider), String(expiryMs), retryAfterSeconds);
  }

  async getCooldownSeconds(provider: string): Promise<number> {
    const value = await this.storage.get(this.key(provider));
    if (!value) return 0;
    const remaining = Math.ceil((Number(value) - Date.now()) / 1000);
    return remaining > 0 ? remaining : 0;
  }
}
