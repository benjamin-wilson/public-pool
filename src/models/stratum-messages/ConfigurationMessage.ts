import { IsArray } from 'class-validator';

import { eRequestMethod } from '../enums/eRequestMethod';
import { StratumBaseMessage } from './StratumBaseMessage';

export class ConfigurationMessage extends StratumBaseMessage {
  @IsArray()
  params: string[];

  constructor() {
    super();
    this.method = eRequestMethod.CONFIGURE;
  }

  public response() {
    return {
      id: this.id,
      error: null,
      result: {
        'version-rolling': true,
        'version-rolling.mask': '1fffe000',
      },
    };
  }
}
