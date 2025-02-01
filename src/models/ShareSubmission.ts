import { IsDate, IsNumber, IsString, IsOptional } from 'class-validator';

export class ShareSubmission {
  @IsString()
  worker: string;

  @IsString()
  address: string;

  @IsString()
  sessionId: string;

  @IsString()
  userAgent: string;

  @IsDate()
  timestamp: Date;

  @IsString()
  header: string; // The block header in hex format for validation
}
