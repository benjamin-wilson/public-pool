export interface IBlockTemplateTx {
  data: string; //'hex',                 // (string) transaction data encoded in hexadecimal (byte-for-byte)
  txid: string; //'hex',                 // (string) transaction id encoded in little-endian hexadecimal
  hash: string; //'hex',                 // (string) hash encoded in little-endian hexadecimal (including witness data)
  depends: number[]; // (json array) array of numbers // (numeric) transactions before this one (by 1-based index in 'transactions' list) that must be present in the final block if this one is
  fee: number; // (numeric) difference in value between transaction inputs and outputs (in satoshis); for coinbase transactions, this is a negative Number of the total collected block fees (ie, not including the block subsidy); if key is not present, fee is unknown and clients MUST NOT assume there isn't one
  sigops: number; // (numeric) total SigOps cost, as counted for purposes of block limits; if key is not present, sigop cost is unknown and clients MUST NOT assume it is zero
  weight: number; // (numeric) total transaction weight, as counted for purposes of block limits
}
export interface IBlockTemplate {
  // (json object)
  version: number; // (numeric) The preferred block version
  rules: string[]; // (json array) specific block rules that are to be enforced  // (string) name of a rule the client must understand to some extent; see BIP 9 for format

  vbavailable:
    | {
        // (json object) set of pending, supported versionbit (BIP 9) softfork deployments
        rulename: number; // (numeric) identifies the bit number as indicating acceptance and readiness for the named softfork rule
      }
    | {};
  vbrequired: number; // (numeric) bit mask of versionbits the server requires set in submissions
  previousblockhash: string; // (string) The hash of current highest block
  transactions: IBlockTemplateTx[]; // (json array) contents of non-coinbase transactions that should be included in the next block
  coinbaseaux:
    | {
        // (json object) data that should be included in the coinbase's scriptSig content
        key: string; //'hex',              // (string) values must be in the coinbase (keys may be ignored)
      }
    | {};
  coinbasevalue: number; // (numeric) maximum allowable input to coinbase transaction, including the generation award and transaction fees (in satoshis)
  longpollid: string; // (string) an id to include with a request to longpoll on an update to this template
  target: string; // (string) The hash target
  mintime: number; // (numeric) The minimum timestamp appropriate for the next block time, expressed in UNIX epoch time
  mutable: string[]; // (json array) list of ways the block template may be changed   // (string) A way the block template may be changed, e.g. 'time', 'transactions', 'prevblock'
  noncerange: string; // 'hex',          // (string) A range of valid nonces
  sigoplimit: number; // (numeric) limit of sigops in blocks
  sizelimit: number; // (numeric) limit of block size
  weightlimit: number; // (numeric) limit of block weight
  curtime: number; // (numeric) current timestamp in UNIX epoch time
  bits: string; // (string) compressed target of next block
  height: number; // (numeric) The height of the next block
  default_witness_commitment: string; // (string, optional) a valid witness commitment for the unmodified block template
  capabilities: string[];
}
