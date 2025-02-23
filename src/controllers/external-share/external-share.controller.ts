import { Body, Controller, Post, Get, UnauthorizedException, Headers } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalPoolShare } from '../../models/ExternalPoolShare';
import { ExternalSharesService } from '../../ORM/external-shares/external-shares.service';
import { DifficultyUtils } from '../../utils/difficulty.utils';
import * as bitcoinjs from 'bitcoinjs-lib';

@Controller('share')
export class ExternalShareController {
  private readonly apiKey: string;
  private readonly minimumDifficulty: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly externalSharesService: ExternalSharesService,
  ) {
    this.apiKey = this.configService.get('SHARE_SUBMISSION_API_KEY');
    this.minimumDifficulty = this.configService.get('MINIMUM_DIFFICULTY') || 1000000000000; // 1T
  }

  @Get('top-difficulties')
  async getTopDifficulties() {
    const topDifficulties = await this.externalSharesService.getTopDifficulties();
    return topDifficulties;
  }

  @Post()
  async submitExternalShare(
    @Body() externalShare: ExternalPoolShare,
    @Headers('x-api-key') apiKey: string,
  ) {
    // Only validate API key if one is configured
    if (this.apiKey && apiKey !== this.apiKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    // Validate the header hash matches claimed difficulty
    const headerBuffer = Buffer.from(externalShare.header, 'hex');
    const { submissionDifficulty: difficulty } = DifficultyUtils.calculateDifficulty(headerBuffer);

    // Verify the calculated difficulty matches or exceeds minimum difficulty
    if (difficulty < this.minimumDifficulty) {
      throw new UnauthorizedException('Share difficulty too low');
    }

    const block = bitcoinjs.Block.fromBuffer(headerBuffer);

    const tenMinutesAgo = Math.floor(Date.now() / 1000) - (10 * 60);

    if (block.timestamp < tenMinutesAgo) {
      throw new UnauthorizedException('Share timestamp too old - must be within last 10 minutes');
    }

    // Store share submission
    await this.externalSharesService.insert({
      address: externalShare.address,
      clientName: externalShare.worker,
      time: new Date().getTime(),
      difficulty: difficulty,
      userAgent: externalShare.userAgent,
      externalPoolName: externalShare.externalPoolName,
      header: externalShare.header
    });

    console.log(`Accepted external share. ${difficulty}`);

    return {
      success: true,
      calculatedDifficulty: difficulty,
    };
  }
}
