import { eResponseMethod } from '../enums/eResponseMethod';

export interface IMiningNotify {
  id: null;
  method: eResponseMethod.MINING_NOTIFY;
  params: [
    string, // jobId 0
    string, // prevHash 1
    string, // coinbase part1 2
    string, // coinbase part2 3
    string[], // merkle_branch 4
    string, // version 5
    string, // bits 6
    string, // timestamp 7
    boolean, // clear jobs 8
  ];
}
