import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ShareSubmission } from '../models/ShareSubmission';

@Injectable()
export class ShareSubmissionService {
  private readonly shareApiUrl: string;
  private readonly shareApiKey: string;

  constructor(private readonly configService: ConfigService) {
    this.shareApiUrl = this.configService.get('SHARE_SUBMISSION_URL') || 'https://web.public-pool.io';
    this.shareApiKey = this.configService.get('SHARE_SUBMISSION_API_KEY');
  }

  public async submitShare(share: ShareSubmission): Promise<void> {
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
