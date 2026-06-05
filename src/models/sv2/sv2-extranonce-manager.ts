// ── SV2 Extranonce Manager ──────────────────────────────────────────
// Manages extranonce prefix allocation for extended mining channels.
// Ensures no two channels share the same prefix to prevent hash collisions.

export class Sv2ExtranonceManager {
  private nextPrefix: number;
  private readonly workerOffset: number;
  private readonly maxPrefix: number;
  private allocatedPrefixes = new Map<number, number>(); // channelId → prefix
  private usedPrefixes = new Set<number>();
  private readonly prefixSize: number;
  private readonly totalExtranonceSize: number;

  /**
   * @param prefixSize Bytes used for pool-assigned prefix (default 4)
   * @param totalExtranonceSize Total extranonce bytes (default 12: 4 prefix + 8 miner-controlled).
   *        Must match MiningJob.ts's coinbase slot size (12 bytes) — both
   *        protocols share the same coinbase template. Bumped from the
   *        previous 8-byte total because the Braiins Hashpower marketplace
   *        requires extranonce2_size >= 7 (compatibility spec).
   */
  constructor(prefixSize = 4, totalExtranonceSize = 12) {
    this.prefixSize = prefixSize;
    this.totalExtranonceSize = totalExtranonceSize;

    const workerId = 0;
    const bitsPerWorker = (prefixSize - 1) * 8;
    this.workerOffset = workerId * Math.pow(2, bitsPerWorker);
    this.maxPrefix = Math.pow(2, bitsPerWorker) - 1; // max within this worker's slice
    this.nextPrefix = 1;
  }

  get minerExtranonceSize(): number {
    return this.totalExtranonceSize - this.prefixSize;
  }

  /**
   * Allocate a unique extranonce prefix for a channel.
   * Returns a Buffer of `prefixSize` bytes.
   */
  allocate(channelId: number): Buffer {
    // Check if already allocated
    if (this.allocatedPrefixes.has(channelId)) {
      const existing = this.allocatedPrefixes.get(channelId)!;
      return this.prefixToBuffer(existing);
    }

    // Find next available prefix within this worker's partition
    let localPrefix = this.nextPrefix;
    let attempts = 0;
    const globalPrefix = () => this.workerOffset + localPrefix;

    while (this.usedPrefixes.has(globalPrefix()) && attempts <= this.maxPrefix) {
      localPrefix = localPrefix + 1;
      if (localPrefix > this.maxPrefix) localPrefix = 1; // Wrap within partition, skip 0
      attempts++;
    }

    if (this.usedPrefixes.has(globalPrefix())) {
      throw new Error('Extranonce prefix space exhausted');
    }

    const prefix = globalPrefix();
    this.allocatedPrefixes.set(channelId, prefix);
    this.usedPrefixes.add(prefix);
    this.nextPrefix = localPrefix + 1;
    if (this.nextPrefix > this.maxPrefix) this.nextPrefix = 1;

    return this.prefixToBuffer(prefix);
  }

  /**
   * Release the prefix allocated to a channel.
   */
  release(channelId: number): void {
    const prefix = this.allocatedPrefixes.get(channelId);
    if (prefix !== undefined) {
      this.allocatedPrefixes.delete(channelId);
      this.usedPrefixes.delete(prefix);
    }
  }

  /**
   * Get the prefix for a channel, or undefined if not allocated.
   */
  getPrefix(channelId: number): Buffer | undefined {
    const prefix = this.allocatedPrefixes.get(channelId);
    if (prefix === undefined) return undefined;
    return this.prefixToBuffer(prefix);
  }

  get allocatedCount(): number {
    return this.allocatedPrefixes.size;
  }

  private prefixToBuffer(prefix: number): Buffer {
    const buf = Buffer.alloc(this.prefixSize);
    // Write as big-endian so prefix 1 = 0x00000001
    if (this.prefixSize === 4) {
      buf.writeUInt32BE(prefix, 0);
    } else if (this.prefixSize === 2) {
      buf.writeUInt16BE(prefix, 0);
    } else {
      // Generic: write big-endian
      let val = prefix;
      for (let i = this.prefixSize - 1; i >= 0; i--) {
        buf[i] = val & 0xff;
        val = val >>> 8;
      }
    }
    return buf;
  }
}
