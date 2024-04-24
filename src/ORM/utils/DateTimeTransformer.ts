import { ValueTransformer } from 'typeorm';

export class DateTimeTransformer implements ValueTransformer {
  to(value: Date): any {
    // Convert the local time to UTC before saving to the database
    const utcTime = value?.toLocaleString();
    return utcTime;
  }

  from(value: any): Date {
    // Convert the UTC time from the database to the local time zone
    return value;
  }
}
