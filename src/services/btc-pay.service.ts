import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';

@Injectable()
export class BTCPayService {
  constructor(private readonly httpService: HttpService) {}

  public createUser() {
    const user = {
      email: 'MyTestUser@gmail.com',
      password: 'NOTVERYSECURE',
      isAdministrator: false,
    };

    this.httpService.post(`/api/v1/users`, user);
  }

  public createNewStore() {
    const token = 'APIKEYTOKEN';
    const store = {
      Name: 'STORENAME',
    };

    this.httpService.post(`/api/v1/stores`, store, {
      headers: { Authorization: 'token ' + token },
    });
  }

  public createPullPayment() {
    const token = 'APIKEYTOKEN';

    const pullPayment = {
      name: 'string',
      description: 'string',
      amount: '0.1',
      currency: 'BTC',
      period: 604800,
      BOLT11Expiration: 30,
      autoApproveClaims: false,
      startsAt: 1592312018,
      expiresAt: 1593129600,
      paymentMethods: ['BTC'],
    };

    this.httpService.post(
      `/api/v1/stores/{storeId}/pull-payments`,
      pullPayment,
      { headers: { Authorization: 'token ' + token } },
    );
  }
}
