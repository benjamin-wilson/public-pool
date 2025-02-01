import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { ShareSubmission } from '../models/ShareSubmission';

@Injectable()
export class ShareSubmissionService {
  private readonly shareApiUrl: string;
  private readonly shareApiKey: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService
  ) {
    this.shareApiUrl = this.configService.get('SHARE_SUBMISSION_URL') || 'https://web.public-pool.io';
    this.shareApiKey = this.configService.get('SHARE_SUBMISSION_API_KEY');
  }

  public submitShare(share: ShareSubmission): void {
    this.httpService.post(`${this.shareApiUrl}/api/submitShare`, share, {
      headers: {
        'x-api-key': this.shareApiKey
      }
    }).subscribe({
      error: (error) => console.error('Failed to submit share to API:', error.message)
    });
  }
}
