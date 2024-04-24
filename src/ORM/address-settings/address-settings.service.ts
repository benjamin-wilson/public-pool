import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AddressSettingsEntity } from './address-settings.entity';

@Injectable()
export class AddressSettingsService {
  constructor(
    @InjectRepository(AddressSettingsEntity)
    private addressSettingsRepository: Repository<AddressSettingsEntity>,
  ) {}

  public async getSettings(address: string, createIfNotFound: boolean) {
    const settings = await this.addressSettingsRepository.findOne({
      where: { address },
    });
    if (createIfNotFound == true && settings == null) {
      // It's possible to have a race condition here so if we get a PK violation, fetch it
      try {
        return await this.createNew(address);
      } catch (e) {
        return await this.addressSettingsRepository.findOne({
          where: { address },
        });
      }
    }
    return settings;
  }

  public async updateBestDifficulty(
    address: string,
    bestDifficulty: number,
    bestDifficultyUserAgent: string,
  ) {
    return await this.addressSettingsRepository.update(
      { address },
      { bestDifficulty, bestDifficultyUserAgent },
    );
  }

  public async getHighScores() {
    return await this.addressSettingsRepository
      .createQueryBuilder()
      .select('"updatedAt", "bestDifficulty", "bestDifficultyUserAgent"')
      .orderBy('"bestDifficulty"', 'DESC')
      .limit(10)
      .execute();
  }

  public async createNew(address: string) {
    return await this.addressSettingsRepository.save({ address });
  }

  public async addShares(address: string, shares: number) {
    return await this.addressSettingsRepository
      .createQueryBuilder()
      .update(AddressSettingsEntity)
      .set({
        shares: () => `"shares" + ${shares}`, // Use the actual value of shares here
      })
      .where('address = :address', { address })
      .execute();
  }

  public async resetBestDifficultyAndShares() {
    return await this.addressSettingsRepository.update(
      {},
      {
        shares: 0,
        bestDifficulty: 0,
      },
    );
  }
}
