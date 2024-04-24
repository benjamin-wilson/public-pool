import { IBlockTemplate } from '../../src/models/bitcoin-rpc/IBlockTemplate';

export class MockRecording1 {
  public static EXTRA_NONCE = `57a6f098`;
  public static MINING_SUBSCRIBE = `{"id": 1, "method": "mining.subscribe", "params": ["bitaxe v2.2"]}`;
  public static MINING_CONFIGURE = `{"id": 2, "method": "mining.configure", "params": [["version-rolling"], {"version-rolling.mask": "ffffffff"}]}`;
  public static MINING_AUTHORIZE = `{"id": 3, "method": "mining.authorize", "params": ["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3", "x"]}`;
  public static MINING_SUGGEST_DIFFICULTY = `{"id": 4, "method": "mining.suggest_difficulty", "params": [512]}`;
  public static BLOCK_TEMPLATE: IBlockTemplate = {
    capabilities: ['proposal'],
    version: 536870912,
    rules: ['csv', '!segwit', 'taproot'],
    vbavailable: {},
    vbrequired: 0,
    previousblockhash:
      '00000000000000022246451e9af7ac4f8bff2527d223f6e623740e92171592f2',
    transactions: [
      {
        data: '02000000000101c3efa41c94ee24dd6c6aaccab0f27e9d2baf92e5112bff15cc463b600e4e3a3c0100000000fdffffff024ea319000000000017a914a5b8d32a6388f02204a1445bd623150ee3b851d18765d67b000000000017a914a316e3a4eaeee9cbee9c254c3292830281a8c9c38702473044022065fbcd2918e8b52c3af8c4ae21b3646d7a12f66ddcaa73a68273f5806527c0da0220291f555dd120bb9eadb144ccf4203db659b78d79bffcd37a29016da068f3abb9012102baab4d464b57771f5108f40ffc31b7242c5b430a61d4bfead024d715c441f3f3c7432500',
        txid: 'a174b99a87c899e66854ba6f101799ac852ef588ec69299846875e9d64355317',
        hash: '748f4db5e45dab6a9903f50e7e760470ce80ac219c637d61418667a0ccb6c536',
        depends: [],
        fee: 14300,
        sigops: 1,
        weight: 569,
      },
      {
        data: '01000000018985719caa78472c8fad7efa88fc109c6faf6df3dc3a690656479e53c6b10fe9030000006b483045022100e7abb2f2f7e6cfad680efe10a7fc218d685a9cce929b1a4e62fcb726228ac9b50220538f3d2eb36d277bcadf00f3ac2abbaf80395c389e1f8048dc95fdf6204cf1840121037435c194e9b01b3d7f7a2802d6684a3af68d05bbf4ec8f17021980d777691f1dfdffffff040000000000000000536a4c5054325b0b15aaff5c59aab47ce39829055c3007922e2934d3b7c9f51238f8d4a98718da4f9c99a6692adacd0e324b7775eebe151c4f3ad37fcc5f9303eed491a02638b8002543c70002002543a7000a4c10270000000000001976a914000000000000000000000000000000000000000088ac10270000000000001976a914000000000000000000000000000000000000000088aca99f6412000000001976a914ba27f99e007c7f605a8305e318c1abde3cd220ac88ac00000000',
        txid: 'c34ac3f822a0b49f298be1a25fc9e9dd375c23985ed2656f7cf7d87b67fee1c0',
        hash: 'c34ac3f822a0b49f298be1a25fc9e9dd375c23985ed2656f7cf7d87b67fee1c0',
        depends: [],
        fee: 9153,
        sigops: 12,
        weight: 1408,
      },
      {
        data: '020000000001013f8e5ebf5620f2c62c9c4e4f77bb4eb903699620da372ad44f666a552e5b9fc801000000171600148442ee1fe3742153a6b40623d363a22ceed677c3ffffffff02bc0200000000000017a91470b93cf7ead31ef24b71159388c2e8e147f755b987aa0415000000000017a9145506e665bcf63e1225100d7c8613a640699fd5d087024730440220215cd74141ebcde3aee383f232dfd2c6b011645012f35714781d28d4a6959829022017ea40a15f4116bbf0a6f86dc0af08758d9a74673498a61164ed13e9d1c712e501210294184e8093958861740c4ce32e724a24b7df7eeb04702cae274652e86b01f83a00000000',
        txid: '5aaf2fa707da25c24374b87d89c420c9e4c51022a4bbed4cc91614831f359366',
        hash: '2c19268e65cc223c5fac9666883ecc1d10e680c54a4fdbbb3e4775f886b0feec',
        depends: [],
        fee: 491,
        sigops: 1,
        weight: 661,
      },
      {
        data: '020000000001012c53f5b0a12cadb57602466e703e60272183b75f3366073f4841dac8e616f2740000000000feffffff02e80300000000000016001496e381bd3fe4bae631adc5a5a420fb9124e5480af0a8100000000000160014cd06fc96fea44c6c5e074ba16dd20b222a0a9b32024730440220440ba2252ea6f70f1b8106897984330a997ef504f7f0dbb89679e44309026f2b02207074ad7dbd9a2bd37a41352527b7f3e68612956fe2085a0eb0b41f97f6a3599d012103b3ecf0f44126019a94a818245e35ecff1582c2900a38487a306fcd91bdb28003c8432500',
        txid: '69770cf296b64329e784a5666fb0eab034fbb1780bf067f4e1606874c214f01d',
        hash: 'fadcaa8de64274e63c093592ed6d8c6b7584bb92c0e8d9c49f02a4df11f6f69d',
        depends: [],
        fee: 141,
        sigops: 1,
        weight: 561,
      },
      {
        data: '01000000019e03cd78895f6876932501b66eab1e44611d48b4c5029d250b7d2d6073b44b68000000006b48304502210088dfbeb842d54893987e5afb87b70fe70e7b91ebad740782515c44464b19a74202205a6bc47ad6c925f85aa29b2be1a174efcc30a4ad8ed6cfe6236b66d7a4f8d96f01210259530ee281106e237ac3aa801d1f7699ada05501186401da78b7d88849bbda8bffffffff0204ce3900000000001976a91419803f0d83a1b58348a4617c743638bbf9ec235588ac44ce5c01000000001976a9149e38aebe02be7cecacdb521f514cffe445c5533788ac00000000',
        txid: '2137ca428d6233e680cea25c428b984391314d872a1a0f5f7b8dc8cfc4474c44',
        hash: '2137ca428d6233e680cea25c428b984391314d872a1a0f5f7b8dc8cfc4474c44',
        depends: [],
        fee: 226,
        sigops: 8,
        weight: 904,
      },
    ],
    coinbaseaux: {},
    coinbasevalue: 2465717,
    longpollid:
      '00000000000000022246451e9af7ac4f8bff2527d223f6e623740e92171592f29370',
    target: '000000000000002495f800000000000000000000000000000000000000000000',
    mintime: 1689512405,
    mutable: ['time', 'transactions', 'prevblock'],
    noncerange: '00000000ffffffff',
    sigoplimit: 80000,
    sizelimit: 4000000,
    weightlimit: 4000000,
    curtime: 1689514989,
    bits: '192495f8',
    height: 2442185,
    default_witness_commitment:
      '6a24aa21a9edbd3d1d916aa0b57326a2d88ebe1b68a1d7c48585f26d8335fe6a94b62755f64c',
  };
  public static MINING_SUBMIT = `{"id": 5, "method": "mining.submit", "params": ["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3", "1", "c7080000", "64b3f3ec", "ed460d91", "00002000"]}`;
  public static TIME = '64b3f3ec';
}
