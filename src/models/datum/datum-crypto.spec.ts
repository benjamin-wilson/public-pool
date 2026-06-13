import * as sodium from 'libsodium-wrappers-sumo';
import {
    DATUM_INITIAL_HEADER_KEY,
    DatumProtocolCommand,
    datumHeaderXorFeedback,
    decodeDatumHeader,
    encodeDatumFrame,
} from './datum-codec';
import { DatumCryptoSession } from './datum-crypto';

describe('DatumCryptoSession', () => {
    it('derives stable DATUM public keys from a configured seed', async () => {
        await sodium.ready;
        const seed = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');

        const first = DatumCryptoSession.generateKeyPairFromSeed(seed);
        const second = DatumCryptoSession.generateKeyPairFromSeed(seed);

        expect(Buffer.concat([first.edPublicKey, first.xPublicKey]).toString('hex'))
            .toBe(Buffer.concat([second.edPublicKey, second.xPublicKey]).toString('hex'));
        expect(first.edSecretKey).toEqual(second.edSecretKey);
    });

    it('opens signed sealed handshakes and builds encrypted responses', async () => {
        await sodium.ready;
        const serverIdentity = DatumCryptoSession.generateKeyPair();
        const serverSessionKeys = DatumCryptoSession.generateKeyPair();
        const clientIdentity = DatumCryptoSession.generateKeyPair();
        const clientSessionKeys = DatumCryptoSession.generateKeyPair();
        const server = await DatumCryptoSession.create(serverIdentity, serverSessionKeys);
        const nextHeaderKey = 0x12345678;

        const signedBody = Buffer.concat([
            clientIdentity.edPublicKey,
            clientIdentity.xPublicKey,
            clientSessionKeys.edPublicKey,
            clientSessionKeys.xPublicKey,
            Buffer.from('datum-test/0\0', 'utf8'),
            Buffer.from([0xfe]),
            uint32(nextHeaderKey),
            Buffer.from([1, 2, 3]),
        ]);
        const signature = Buffer.from(sodium.crypto_sign_detached(signedBody, clientIdentity.edSecretKey));
        const encrypted = Buffer.from(sodium.crypto_box_seal(
            Buffer.concat([signedBody, signature]),
            serverIdentity.xPublicKey,
        ));
        const frame = encodeDatumFrame({
            header: {
                cmdLen: encrypted.length,
                reserved: 0,
                isSigned: true,
                isEncryptedPubkey: true,
                isEncryptedChannel: false,
                protoCmd: DatumProtocolCommand.HANDSHAKE_INIT,
            },
            payload: encrypted,
        }, DATUM_INITIAL_HEADER_KEY);
        const header = decodeDatumHeader(frame.subarray(0, 4), DATUM_INITIAL_HEADER_KEY);

        const hello = server.openHandshake(frame.subarray(4, 4 + header.cmdLen));
        expect(hello.userAgent).toBe('datum-test/0');
        expect(hello.nextHeaderKey).toBe(nextHeaderKey);
        expect(hello.sessionXPublicKey).toEqual(clientSessionKeys.xPublicKey);

        const response = server.buildHandshakeResponse(hello, 'motd');
        const responseHeader = decodeDatumHeader(response.subarray(0, 4), datumHeaderXorFeedback((~nextHeaderKey) >>> 0));
        expect(responseHeader.protoCmd).toBe(DatumProtocolCommand.HANDSHAKE_RESPONSE);
        expect(responseHeader.isSigned).toBe(true);
        expect(responseHeader.isEncryptedPubkey).toBe(true);
        const opened = Buffer.from(sodium.crypto_box_seal_open(
            response.subarray(4),
            clientSessionKeys.xPublicKey,
            clientSessionKeys.xSecretKey,
        ));
        expect(opened.subarray(0, 32)).toEqual(clientIdentity.edPublicKey);
        expect(opened.subarray(128, 160)).toEqual(serverSessionKeys.edPublicKey);

        const ping = server.encryptChannelFrame(DatumProtocolCommand.PING, Buffer.alloc(0));
        const pingHeader = decodeDatumHeader(
            ping.subarray(0, 4),
            datumHeaderXorFeedback(datumHeaderXorFeedback((~nextHeaderKey) >>> 0)),
        );
        expect(pingHeader.protoCmd).toBe(DatumProtocolCommand.PING);
        expect(pingHeader.isEncryptedChannel).toBe(true);
        expect(pingHeader.cmdLen).toBe(sodium.crypto_box_MACBYTES);
    });
});

function uint32(value: number): Buffer {
    const result = Buffer.alloc(4);
    result.writeUInt32LE(value >>> 0, 0);
    return result;
}
