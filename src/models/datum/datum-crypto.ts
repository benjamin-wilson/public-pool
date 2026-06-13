import * as crypto from 'crypto';
import * as sodium from 'libsodium-wrappers-sumo';
import {
    DATUM_INITIAL_HEADER_KEY,
    DatumFrame,
    DatumProtocolCommand,
    decodeDatumHeader,
    encodeDatumFrame,
    datumHeaderXorFeedback,
} from './datum-codec';

export interface DatumKeyPair {
    edPublicKey: Buffer;
    edSecretKey: Buffer;
    xPublicKey: Buffer;
    xSecretKey: Buffer;
}

export interface DatumHello {
    identityEdPublicKey: Buffer;
    identityXPublicKey: Buffer;
    sessionEdPublicKey: Buffer;
    sessionXPublicKey: Buffer;
    userAgent: string;
    nextHeaderKey: number;
}

export class DatumCryptoSession {
    private initialized = false;
    private sharedSecret: Uint8Array | null = null;
    private receiveNonce: Buffer | null = null;
    private sendNonce: Buffer | null = null;
    private receiveHeaderKey = DATUM_INITIAL_HEADER_KEY;
    private sendHeaderKey = DATUM_INITIAL_HEADER_KEY;
    private clientIdentityXPublicKey: Buffer | null = null;

    private constructor(
        private readonly identityKeys: DatumKeyPair,
        private readonly sessionKeys: DatumKeyPair,
    ) {}

    public static async create(identityKeys?: DatumKeyPair, sessionKeys?: DatumKeyPair): Promise<DatumCryptoSession> {
        await sodium.ready;
        return new DatumCryptoSession(
            identityKeys ?? DatumCryptoSession.generateKeyPair(),
            sessionKeys ?? DatumCryptoSession.generateKeyPair(),
        );
    }

    public get publicKeyHex(): string {
        return Buffer.concat([this.identityKeys.edPublicKey, this.identityKeys.xPublicKey]).toString('hex');
    }

    public get currentReceiveHeaderKey(): number {
        return this.receiveHeaderKey;
    }

    public get currentSendHeaderKey(): number {
        return this.sendHeaderKey;
    }

    public openHandshake(framePayload: Buffer): DatumHello {
        const opened = Buffer.from(sodium.crypto_box_seal_open(
            framePayload,
            this.identityKeys.xPublicKey,
            this.identityKeys.xSecretKey,
        ));
        if (opened.length < 32 * 4 + 1 + 4 + sodium.crypto_sign_BYTES) {
            throw new Error('DATUM handshake payload is too short');
        }

        const signature = opened.subarray(opened.length - sodium.crypto_sign_BYTES);
        const signedPayload = opened.subarray(0, opened.length - sodium.crypto_sign_BYTES);
        const clientIdentityEdPublicKey = signedPayload.subarray(0, 32);
        if (!sodium.crypto_sign_verify_detached(signature, signedPayload, clientIdentityEdPublicKey)) {
            throw new Error('DATUM handshake signature verification failed');
        }

        let offset = 0;
        const hello: DatumHello = {
            identityEdPublicKey: Buffer.from(signedPayload.subarray(offset, offset += 32)),
            identityXPublicKey: Buffer.from(signedPayload.subarray(offset, offset += 32)),
            sessionEdPublicKey: Buffer.from(signedPayload.subarray(offset, offset += 32)),
            sessionXPublicKey: Buffer.from(signedPayload.subarray(offset, offset += 32)),
            userAgent: '',
            nextHeaderKey: 0,
        };

        const userAgentStart = offset;
        while (offset < signedPayload.length && signedPayload[offset] !== 0) {
            offset++;
        }
        hello.userAgent = signedPayload.subarray(userAgentStart, offset).toString('utf8');
        offset++;

        if (signedPayload[offset] !== 0xfe) {
            throw new Error('DATUM handshake missing key delimiter');
        }
        offset++;
        hello.nextHeaderKey = signedPayload.readUInt32LE(offset);

        this.clientIdentityXPublicKey = hello.identityXPublicKey;
        this.sharedSecret = sodium.crypto_box_beforenm(hello.sessionXPublicKey, this.sessionKeys.xSecretKey);
        this.receiveHeaderKey = datumHeaderXorFeedback(hello.nextHeaderKey);
        this.sendHeaderKey = datumHeaderXorFeedback((~hello.nextHeaderKey) >>> 0);
        this.initializeNonces(hello.nextHeaderKey, hello.sessionEdPublicKey);
        this.initialized = true;

        return hello;
    }

    public buildHandshakeResponse(hello: DatumHello, motd: string): Buffer {
        if (this.clientIdentityXPublicKey == null) {
            throw new Error('Cannot build DATUM handshake response before opening client hello');
        }

        const body = Buffer.concat([
            hello.identityEdPublicKey,
            hello.identityXPublicKey,
            hello.sessionEdPublicKey,
            hello.sessionXPublicKey,
            this.sessionKeys.edPublicKey,
            this.sessionKeys.xPublicKey,
            Buffer.from(`${motd}\0`, 'utf8'),
        ]);
        const signature = Buffer.from(sodium.crypto_sign_detached(body, this.identityKeys.edSecretKey));
        const encrypted = Buffer.from(sodium.crypto_box_seal(
            Buffer.concat([body, signature]),
            hello.sessionXPublicKey,
        ));

        const response = encodeDatumFrame({
            header: {
                cmdLen: encrypted.length,
                reserved: 0,
                isSigned: true,
                isEncryptedPubkey: true,
                isEncryptedChannel: false,
                protoCmd: DatumProtocolCommand.HANDSHAKE_RESPONSE,
            },
            payload: encrypted,
        }, this.sendHeaderKey);
        this.sendHeaderKey = datumHeaderXorFeedback(this.sendHeaderKey);
        return response;
    }

    public decryptChannelPayload(payload: Buffer): Buffer {
        if (!this.initialized || this.sharedSecret == null || this.receiveNonce == null) {
            throw new Error('DATUM channel is not initialized');
        }
        const opened = sodium.crypto_box_open_easy_afternm(payload, this.receiveNonce, this.sharedSecret);
        this.incrementNonce(this.receiveNonce);
        this.receiveHeaderKey = datumHeaderXorFeedback(this.receiveHeaderKey);
        return Buffer.from(opened);
    }

    public encryptChannelFrame(protoCmd: DatumProtocolCommand, payload: Buffer, signed = false): Buffer {
        if (!this.initialized || this.sharedSecret == null || this.sendNonce == null) {
            throw new Error('DATUM channel is not initialized');
        }
        const signedPayload = signed
            ? Buffer.concat([payload, Buffer.from(sodium.crypto_sign_detached(payload, this.sessionKeys.edSecretKey))])
            : payload;
        const encrypted = Buffer.from(sodium.crypto_box_easy_afternm(signedPayload, this.sendNonce, this.sharedSecret));
        const frame = encodeDatumFrame({
            header: {
                cmdLen: encrypted.length,
                reserved: 0,
                isSigned: signed,
                isEncryptedPubkey: false,
                isEncryptedChannel: true,
                protoCmd,
            },
            payload: encrypted,
        }, this.sendHeaderKey);
        this.incrementNonce(this.sendNonce);
        this.sendHeaderKey = datumHeaderXorFeedback(this.sendHeaderKey);
        return frame;
    }

    public decodeHeader(headerBytes: Buffer): ReturnType<typeof decodeDatumHeader> {
        return decodeDatumHeader(headerBytes, this.receiveHeaderKey);
    }

    private initializeNonces(nextHeaderKey: number, clientSessionEdPublicKey: Buffer): void {
        const receiver = Buffer.alloc(sodium.crypto_box_NONCEBYTES);
        let key = ((nextHeaderKey - 42) ^ clientSessionEdPublicKey.readUInt32LE(7)) >>> 0;
        for (let i = 0; i < receiver.length; i += 4) {
            receiver.writeUInt32LE(datumHeaderXorFeedback((key - 42) >>> 0), i);
            key = (~receiver.readUInt32LE(i)) >>> 0;
        }

        const sender = Buffer.alloc(receiver.length);
        for (let i = 0; i < receiver.length; i += 4) {
            sender.writeUInt32LE((receiver.readUInt32LE(i) ^ 0x57575757) >>> 0, i);
        }

        this.sendNonce = receiver;
        this.receiveNonce = sender;
    }

    private incrementNonce(nonce: Buffer): void {
        for (let offset = 0; offset < nonce.length; offset += 4) {
            const next = (nonce.readUInt32LE(offset) + 1) >>> 0;
            nonce.writeUInt32LE(next, offset);
            if (next !== 0) {
                return;
            }
        }
    }

    public static generateKeyPair(): DatumKeyPair {
        const seed = crypto.randomBytes(32);
        return DatumCryptoSession.generateKeyPairFromSeed(seed);
    }

    public static generateKeyPairFromSeed(seed: Buffer): DatumKeyPair {
        if (seed.length !== 32) {
            throw new RangeError(`DATUM key seed must be 32 bytes, got ${seed.length}`);
        }
        const ed = sodium.crypto_sign_seed_keypair(seed);
        const xPublicKey = sodium.crypto_sign_ed25519_pk_to_curve25519(ed.publicKey);
        const xSecretKey = sodium.crypto_sign_ed25519_sk_to_curve25519(ed.privateKey);
        return {
            edPublicKey: Buffer.from(ed.publicKey),
            edSecretKey: Buffer.from(ed.privateKey),
            xPublicKey: Buffer.from(xPublicKey),
            xSecretKey: Buffer.from(xSecretKey),
        };
    }
}

export function buildDatumPlainFrame(protoCmd: DatumProtocolCommand, payload: Buffer): DatumFrame {
    return {
        header: {
            cmdLen: payload.length,
            reserved: 0,
            isSigned: false,
            isEncryptedPubkey: false,
            isEncryptedChannel: false,
            protoCmd,
        },
        payload,
    };
}
