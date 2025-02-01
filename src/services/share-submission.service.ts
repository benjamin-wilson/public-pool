import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

interface ShareSubmission {
  worker: string;
  address: string;
  difficulty: number;
  sessionId: string;
  userAgent: string;
  timestamp: Date;
  blockHex?: string;
  header: string;
}

@Injectable()
export class ShareSubmissionService {
  private readonly shareApiUrl: string;
  private readonly shareApiKey: string;
  private readonly minimumDifficulty: number = 1000000000; // 1G/B

  constructor(private readonly configService: ConfigService) {
    this.shareApiUrl = this.configService.get('SHARE_SUBMISSION_URL') || 'https://web.public-pool.io';
    this.shareApiKey = this.configService.get('SHARE_SUBMISSION_API_KEY');
  }

  public async submitShare(share: ShareSubmission): Promise<void> {
    if (!this.shareApiUrl || share.difficulty < this.minimumDifficulty) {
      return;
    }

    try {
      await axios.post(`${this.shareApiUrl}/api/submitShare`, share, {
        headers: {
          'x-api-key': this.shareApiKey
        }
      });
    } catch (error) {
      console.error('Failed to submit share to API:', error.message);
    }
  }
}
