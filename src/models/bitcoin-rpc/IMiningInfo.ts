export interface IMiningInfo {
  blocks: number;
  currentblockweight: number;
  currentblocktx: number;
  difficulty: number;
  networkhashps: number;
  pooledtx: number;
  chain: 'main' | 'test' | 'regtest';
  warnings: string;
}
