import { Body, Controller, Post, UnauthorizedException, Headers } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bitcoinjs from 'bitcoinjs-lib';
import Big from 'big.js';
import { ShareSubmission } from '../../models/ShareSubmission';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { AddressSettingsService } from '../../ORM/address-settings/address-settings.service';

@Controller('share')
export class ShareController {
  private readonly apiKey: string;
  private readonly minimumDifficulty: number = 1000000000; // 1G/B

  constructor(
    private readonly configService: ConfigService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly addressSettingsService: AddressSettingsService,
  ) {
    this.apiKey = this.configService.get('SHARE_SUBMISSION_API_KEY');
  }

  @Post()
  async submitShare(
    @Body() submission: ShareSubmission,
    @Headers('x-api-key') apiKey: string,
  ) {
    // Only validate API key if one is configured
    if (this.apiKey && apiKey !== this.apiKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    // Validate minimum difficulty
    if (submission.difficulty < this.minimumDifficulty) {
      throw new UnauthorizedException('Share difficulty too low');
    }

    // Validate header format
    if (!submission.header || !/^[0-9a-fA-F]+$/.test(submission.header)) {
      throw new UnauthorizedException('Invalid header format - must be a valid hex string');
    }

    // Validate the header hash matches claimed difficulty
    const headerBuffer = Buffer.from(submission.header, 'hex');
    const hashResult = bitcoinjs.crypto.hash256(headerBuffer);
    const difficulty = this.calculateDifficulty(hashResult);

    // Verify the calculated difficulty matches or exceeds claimed difficulty
    if (difficulty < submission.difficulty) {
      throw new UnauthorizedException('Invalid share - calculated difficulty does not match claimed difficulty');
    }

    // Store the share statistics
    await this.clientStatisticsService.insert({
      address: submission.address,
      clientName: submission.worker,
      sessionId: submission.sessionId,
      time: new Date().getTime(),
      shares: submission.difficulty,
      acceptedCount: 1
    });

    // Update address settings with shares
    await this.addressSettingsService.addShares(submission.address, submission.difficulty);

    // Update best difficulty if this share is better
    if (difficulty > (await this.addressSettingsService.getSettings(submission.address, true)).bestDifficulty) {
      await this.addressSettingsService.updateBestDifficulty(
        submission.address, 
        difficulty,
        submission.userAgent
      );
    }
    
    return {
      success: true,
      calculatedDifficulty: difficulty,
    };
  }

  private calculateDifficulty(hashResult: Buffer): number {
    const s64 = this.le256todouble(hashResult);
    const truediffone = Big('26959535291011309493156476344723991336010898738574164086137773096960');
    const difficulty = truediffone.div(s64.toString());
    return difficulty.toNumber();
  }

  private le256todouble(target: Buffer): bigint {
    const number = target.reduceRight((acc, byte) => {
      return (acc << BigInt(8)) | BigInt(byte);
    }, BigInt(0));
    return number;
  }
} 
