import { Injectable } from '@nestjs/common';
import { from, map, Observable, shareReplay, switchMap, tap } from 'rxjs';

import { BitcoinRpcService } from './bitcoin-rpc.service';
import { IBlockTemplate } from './models/bitcoin-rpc/IBlockTemplate';
import { IMiningInfo } from './models/bitcoin-rpc/IMiningInfo';

@Injectable()
export class BlockTemplateService {

    public currentBlockTemplate: IBlockTemplate;

    public currentBlockTemplate$: Observable<{ miningInfo: IMiningInfo, blockTemplate: IBlockTemplate }>;

    constructor(private readonly bitcoinRpcService: BitcoinRpcService) {
        this.currentBlockTemplate$ = this.bitcoinRpcService.newBlock$.pipe(
            switchMap((miningInfo) => from(this.bitcoinRpcService.getBlockTemplate()).pipe(map(blockTemplate => { return { miningInfo, blockTemplate } }))),
            tap(({ miningInfo, blockTemplate }) => this.currentBlockTemplate = blockTemplate),
            shareReplay({ refCount: true, bufferSize: 1 })
        );
    }

}