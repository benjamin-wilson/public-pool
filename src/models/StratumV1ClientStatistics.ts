import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';

const CACHE_SIZE = 30;
const TARGET_SUBMISSION_PER_SECOND = 10;
const MIN_DIFF = 0.00001;
export class StratumV1ClientStatistics {
  private shares = 0;
  private acceptedCount = 0;

  private submissionCacheStart: Date;
  private submissionCache: { time: Date; difficulty: number }[] = [];

  private currentTimeSlot: number = null;
  private lastSave: number = null;

  constructor(
    private readonly clientStatisticsService: ClientStatisticsService,
  ) {
    this.submissionCacheStart = new Date();
  }

  // We don't want to save them here because it can be DB intensive, instead do it every once in
  // awhile with saveShares()
  public async addShares(client: ClientEntity, targetDifficulty: number) {
    // 10 min
    const coeff = 1000 * 60 * 10;
    const date = new Date();
    const timeSlot = new Date(
      Math.floor(date.getTime() / coeff) * coeff,
    ).getTime();

    if (this.submissionCache.length > CACHE_SIZE) {
      this.submissionCache.shift();
    }
    this.submissionCache.push({
      time: date,
      difficulty: targetDifficulty,
    });

    if (this.currentTimeSlot == null) {
      // First record, insert it
      this.currentTimeSlot = timeSlot;
      this.shares += targetDifficulty;
      this.acceptedCount++;
      await this.clientStatisticsService.insert({
        time: this.currentTimeSlot,
        shares: this.shares,
        acceptedCount: this.acceptedCount,
        address: client.address,
        clientName: client.clientName,
        sessionId: client.sessionId,
      });
      this.lastSave = new Date().getTime();
    } else if (this.currentTimeSlot != timeSlot) {
      // Transitioning to a new time slot,
      // First update the old time slot with the latest data
      await this.clientStatisticsService.update({
        time: this.currentTimeSlot,
        shares: this.shares,
        acceptedCount: this.acceptedCount,
        address: client.address,
        clientName: client.clientName,
        sessionId: client.sessionId,
      });
      // Set the new time slot and add incoming shares then insert it
      this.currentTimeSlot = timeSlot;
      this.shares = targetDifficulty;
      this.acceptedCount = 1;
      await this.clientStatisticsService.insert({
        time: this.currentTimeSlot,
        shares: this.shares,
        acceptedCount: this.acceptedCount,
        address: client.address,
        clientName: client.clientName,
        sessionId: client.sessionId,
      });
      this.lastSave = new Date().getTime();
    } else if (date.getTime() - 60 * 1000 > this.lastSave) {
      // If we haven't saved for a minute, update the table
      this.shares += targetDifficulty;
      this.acceptedCount++;
      await this.clientStatisticsService.update({
        time: this.currentTimeSlot,
        shares: this.shares,
        acceptedCount: this.acceptedCount,
        address: client.address,
        clientName: client.clientName,
        sessionId: client.sessionId,
      });
      this.lastSave = new Date().getTime();
    } else {
      // Accept the shares if none of the prior conditions are met,
      // saving to memory for storing later
      this.shares += targetDifficulty;
      this.acceptedCount++;
    }
  }

  public getSuggestedDifficulty(clientDifficulty: number) {
    // miner hasn't submitted shares in one minute
    if (this.submissionCache.length < 5) {
      if (
        (new Date().getTime() - this.submissionCacheStart.getTime()) / 1000 >
        60
      ) {
        return this.nearestPowerOfTwo(clientDifficulty / 6);
      } else {
        return null;
      }
    }

    const sum = this.submissionCache.reduce((pre, cur) => {
      pre += cur.difficulty;
      return pre;
    }, 0);
    const diffSeconds =
      (this.submissionCache[this.submissionCache.length - 1].time.getTime() -
        this.submissionCache[0].time.getTime()) /
      1000;

    const difficultyPerSecond = sum / diffSeconds;

    const targetDifficulty = difficultyPerSecond * TARGET_SUBMISSION_PER_SECOND;

    if (
      clientDifficulty * 2 < targetDifficulty ||
      clientDifficulty / 2 > targetDifficulty
    ) {
      return this.nearestPowerOfTwo(targetDifficulty);
    }

    return null;
  }

  private nearestPowerOfTwo(val): number {
    if (val === 0) {
      return null;
    }
    if (val < MIN_DIFF) {
      return MIN_DIFF;
    }
    let x = val | (val >> 1);
    x = x | (x >> 2);
    x = x | (x >> 4);
    x = x | (x >> 8);
    x = x | (x >> 16);
    x = x | (x >> 32);
    const res = x - (x >> 1);
    if (res == 0 && val * 100 < MIN_DIFF) {
      return MIN_DIFF;
    }
    if (res == 0) {
      return this.nearestPowerOfTwo(val * 100) / 100;
    }
    return res;
  }
}
