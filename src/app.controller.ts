import { Controller, Get } from '@nestjs/common';

import { ClientService } from './ORM/client/client.service';



@Controller()
export class AppController {
  constructor(
    private clientService: ClientService
  ) { }

  @Get('info')
  public info() {

  }

}
