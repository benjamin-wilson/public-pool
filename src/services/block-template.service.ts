import { Injectable } from '@nestjs/common';
import { from, map, Observable, shareReplay, switchMap } from 'rxjs';

import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { BitcoinRpcService } from './bitcoin-rpc.service';

@Injectable()
export class BlockTemplateService {


    public currentBlockTemplate$: Observable<{ blockTemplate: IBlockTemplate }>;

    constructor(private readonly bitcoinRpcService: BitcoinRpcService) {
        this.currentBlockTemplate$ = this.bitcoinRpcService.newBlock$.pipe(
            switchMap((miningInfo) => from(this.bitcoinRpcService.getBlockTemplate()).pipe(map(blockTemplate => { return { miningInfo, blockTemplate } }))),
            shareReplay({ refCount: true, bufferSize: 1 })
        );
    }

}