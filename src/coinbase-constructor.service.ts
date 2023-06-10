import { Injectable } from '@nestjs/common';

import { BitcoinRpcService } from './bitcoin-rpc.service';


@Injectable()
export class CoinbaseConstructorService {

    constructor(private bitcoinRPCService: BitcoinRpcService) {

    }


}