import { HttpService } from '@nestjs/axios';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { map } from 'rxjs';

@Injectable()
export class BraiinsService implements OnModuleInit {
  constructor(private readonly httpService: HttpService) {}

  onModuleInit() {
    // this.getUserProfile().subscribe((res) => {
    //     console.log(`Braiins:`)
    //     console.log(res);
    // })
    // this.getBlockRewards(new Date(0), new Date()).subscribe(res => {
    //     console.log(`Braiins:`)
    //     console.log(res);
    // })
  }

  public getUserProfile() {
    return this.httpService
      .get(`https://pool.braiins.com/accounts/profile/json/BTC`, {
        headers: { 'SlushPool-Auth-Token': process.env.BRAIINS_ACCESS_TOKEN },
      })
      .pipe(map((res) => res.data));
  }

  public getBlockRewards(from: Date, to: Date) {
    return this.httpService
      .get(
        `https://pool.braiins.com/accounts/block_rewards/json/BTC?from=${
          from.toISOString().split('T')[0]
        }&to=${to.toISOString().split('T')[0]}`,
        {
          headers: { 'SlushPool-Auth-Token': process.env.BRAIINS_ACCESS_TOKEN },
        },
      )
      .pipe(map((res) => res.data));
  }
}
