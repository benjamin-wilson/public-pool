import { ValidationError } from 'class-validator';

import { eStratumErrorCode } from '../enums/eStratumErrorCode';

export class StratumErrorMessage {
  constructor(
    private id: number = null,
    private errorCode: eStratumErrorCode,
    private errorMessage: string,
    private validationErrors: ValidationError[] = [],
  ) {}

  public response(): string {
    const error = {
      id: this.id,
      result: null,
      error: [
        this.errorCode,
        this.errorMessage,
        this.validationErrors.reduce((pre, cur) => `${pre}, ${cur.value}`, ''),
      ],
    };
    return JSON.stringify(error) + '\n';
  }
}
