import { Body, Controller, Post, UnauthorizedException, Headers } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ShareSubmission } from '../../models/ShareSubmission';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { ShareSubmissionsService } from '../../ORM/share-submissions/share-submissions.service';
import { DifficultyUtils } from '../../utils/difficulty.utils';

@Controller('share')
export class ShareController {
  private readonly apiKey: string;
  private readonly minimumDifficulty: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly shareSubmissionsService: ShareSubmissionsService,
  ) {
    this.apiKey = this.configService.get('SHARE_SUBMISSION_API_KEY');
    this.minimumDifficulty = this.configService.get('MINIMUM_DIFFICULTY') || 1000000000000; // 1T
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

    // Validate the header hash matches claimed difficulty
    const headerBuffer = Buffer.from(submission.header, 'hex');
    const { submissionDifficulty: difficulty } = DifficultyUtils.calculateDifficulty(headerBuffer);

    // Verify the calculated difficulty matches or exceeds minimum difficulty
    if (difficulty < this.minimumDifficulty) {
      throw new UnauthorizedException('Share difficulty too low');
    }

    const timestamp = headerBuffer.readUInt32LE(68);
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - (10 * 60);
    
    if (timestamp < tenMinutesAgo) {
      throw new UnauthorizedException('Share timestamp too old - must be within last 10 minutes');
    }

    // Store share submission
    await this.shareSubmissionsService.insert({
      address: submission.address,
      clientName: submission.worker,
      sessionId: submission.sessionId,
      time: new Date().getTime(),
      difficulty: difficulty,
      userAgent: submission.userAgent
    });

    return {
      success: true,
      calculatedDifficulty: difficulty,
    };
  }
}
