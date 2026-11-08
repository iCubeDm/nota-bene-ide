// Noise_IK_25519_ChaChaPoly_SHA256 (Noise spec revision 34, sections 4, 5 and 7.5) on node:crypto. The phone is the
// initiator and pins the host's static key from the pairing QR; the host is the responder. Checked against the
// official vectors in noise-vectors.json (noise.test.ts); the Dart side must pass the same file.
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, type KeyObject } from 'node:crypto';

export type KeyPair = { pub: Buffer; priv: Buffer };

export class NoiseError extends Error {}

export const PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_SHA256';
export const PROLOGUE = Buffer.from('nb-e2e-v1');
export const MAX_MESSAGE = 65535;
export const MAX_PLAINTEXT = MAX_MESSAGE - 16;

const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const privObj = (priv: Buffer): KeyObject => createPrivateKey({ key: Buffer.concat([PKCS8, priv]), format: 'der', type: 'pkcs8' });
const pubObj = (pub: Buffer): KeyObject => createPublicKey({ key: Buffer.concat([SPKI, pub]), format: 'der', type: 'spki' });
const rawPub = (k: KeyObject): Buffer => k.export({ format: 'der', type: 'spki' }).subarray(SPKI.length);
const check32 = (b: Buffer, what: string) => {
  if (b.length !== 32) throw new NoiseError(`${what} must be 32 bytes`);
};

export function generateKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  return { priv: privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8.length), pub: rawPub(publicKey) };
}

export function publicOf(priv: Buffer): Buffer {
  check32(priv, 'a private key');
  return rawPub(createPublicKey(privObj(priv)));
}

/** X25519; a low-order peer key (an all-zero result) is refused. */
export function dh(priv: Buffer, pub: Buffer): Buffer {
  check32(priv, 'a private key');
  check32(pub, 'a public key');
  let out: Buffer;
  try {
    out = diffieHellman({ privateKey: privObj(priv), publicKey: pubObj(pub) });
  } catch {
    throw new NoiseError('key agreement failed');
  }
  if (out.every((b) => b === 0)) throw new NoiseError('key agreement failed');
  return out;
}

const sha256 = (...parts: Buffer[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};
const hmac = (key: Buffer, ...parts: Buffer[]): Buffer => {
  const h = createHmac('sha256', key);
  for (const p of parts) h.update(p);
  return h.digest();
};
function hkdf(ck: Buffer, ikm: Buffer): [Buffer, Buffer] {
  const temp = hmac(ck, ikm);
  const o1 = hmac(temp, Buffer.from([1]));
  return [o1, hmac(temp, o1, Buffer.from([2]))];
}

const MAX_NONCE = 2n ** 64n - 1n; // reserved by the spec

export class CipherState {
  #k: Buffer | null;
  #n = 0n;
  #dead = false;

  constructor(k: Buffer | null = null) {
    this.#k = k;
  }

  get hasKey(): boolean {
    return this.#k !== null;
  }

  #nonce(): Buffer {
    if (this.#dead) throw new NoiseError('the channel failed earlier');
    if (this.#n >= MAX_NONCE) throw new NoiseError('nonce exhausted');
    const iv = Buffer.alloc(12);
    iv.writeBigUInt64LE(this.#n, 4);
    return iv;
  }

  encrypt(plain: Buffer, ad: Buffer = Buffer.alloc(0)): Buffer {
    if (plain.length > MAX_PLAINTEXT) throw new NoiseError('message too large');
    if (!this.#k) return Buffer.from(plain);
    const c = createCipheriv('chacha20-poly1305', this.#k, this.#nonce(), { authTagLength: 16 });
    c.setAAD(ad);
    const out = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    this.#n++;
    return out;
  }

  /** A failed decrypt leaves the state unusable: the channel is torn down, never resynchronised. */
  decrypt(cipher: Buffer, ad: Buffer = Buffer.alloc(0)): Buffer {
    if (!this.#k) return Buffer.from(cipher);
    const iv = this.#nonce();
    try {
      if (cipher.length < 16 || cipher.length > MAX_MESSAGE) throw new Error('length');
      const d = createDecipheriv('chacha20-poly1305', this.#k, iv, { authTagLength: 16 });
      d.setAAD(ad);
      d.setAuthTag(cipher.subarray(cipher.length - 16));
      const out = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
      this.#n++;
      return out;
    } catch {
      this.#dead = true;
      throw new NoiseError('decryption failed');
    }
  }
}

class SymmetricState {
  ck: Buffer;
  h: Buffer;
  cs = new CipherState();

  constructor() {
    const name = Buffer.from(PROTOCOL_NAME);
    this.h = name.length <= 32 ? Buffer.concat([name, Buffer.alloc(32 - name.length)]) : sha256(name);
    this.ck = this.h;
  }

  mixKey(ikm: Buffer): void {
    const [ck, k] = hkdf(this.ck, ikm);
    this.ck = ck;
    this.cs = new CipherState(k);
  }

  mixHash(data: Buffer): void {
    this.h = sha256(this.h, data);
  }

  encryptAndHash(plain: Buffer): Buffer {
    const c = this.cs.encrypt(plain, this.h);
    this.mixHash(c);
    return c;
  }

  decryptAndHash(cipher: Buffer): Buffer {
    const p = this.cs.decrypt(cipher, this.h);
    this.mixHash(cipher);
    return p;
  }
}

type Step = 'write1' | 'read1' | 'write2' | 'read2' | 'done' | 'failed';

/** One IK handshake: `<- s ... -> e, es, s, ss` then `<- e, ee, se`. */
export class Handshake {
  #ss = new SymmetricState();
  #s: KeyPair;
  #e: KeyPair | undefined;
  #rs: Buffer | undefined;
  #re: Buffer | undefined;
  #initiator: boolean;
  #step: Step;

  private constructor(o: { s: KeyPair; rs?: Buffer; prologue: Buffer; e?: KeyPair }, initiator: boolean) {
    this.#s = o.s;
    this.#e = o.e;
    this.#rs = o.rs;
    this.#initiator = initiator;
    this.#step = initiator ? 'write1' : 'read1';
    this.#ss.mixHash(o.prologue);
    // pre-message: the responder's static key, known to both
    this.#ss.mixHash(initiator ? o.rs! : o.s.pub);
  }

  static initiator(o: { s: KeyPair; rs: Buffer; prologue: Buffer; e?: KeyPair }): Handshake {
    check32(o.rs, 'the remote static key');
    return new Handshake(o, true);
  }

  static responder(o: { s: KeyPair; prologue: Buffer; e?: KeyPair }): Handshake {
    return new Handshake(o, false);
  }

  get remoteStatic(): Buffer | undefined {
    return this.#rs; // the responder learns it only from a message 1 that decrypted
  }

  get handshakeHash(): Buffer {
    return this.#ss.h;
  }

  #expect(step: Step): void {
    if (this.#step !== step) throw new NoiseError(`handshake out of order (at ${this.#step})`);
  }

  #guard<T>(next: Step, f: () => T): T {
    try {
      const out = f();
      this.#step = next;
      return out;
    } catch (e) {
      this.#step = 'failed';
      throw e instanceof NoiseError ? e : new NoiseError((e as Error).message);
    }
  }

  writeMessage(payload: Buffer): Buffer {
    if (this.#initiator) {
      this.#expect('write1');
      return this.#guard('read2', () => {
        const ss = this.#ss;
        const e = (this.#e ??= generateKeyPair());
        ss.mixHash(e.pub);
        ss.mixKey(dh(e.priv, this.#rs!)); // es
        const s = ss.encryptAndHash(this.#s.pub);
        ss.mixKey(dh(this.#s.priv, this.#rs!)); // ss
        return this.#sized(Buffer.concat([e.pub, s, ss.encryptAndHash(payload)]));
      });
    }
    this.#expect('write2');
    return this.#guard('done', () => {
      const ss = this.#ss;
      const e = (this.#e ??= generateKeyPair());
      ss.mixHash(e.pub);
      ss.mixKey(dh(e.priv, this.#re!)); // ee
      ss.mixKey(dh(e.priv, this.#rs!)); // se
      return this.#sized(Buffer.concat([e.pub, ss.encryptAndHash(payload)]));
    });
  }

  readMessage(msg: Buffer): Buffer {
    if (msg.length > MAX_MESSAGE) throw new NoiseError('message too large');
    if (!this.#initiator) {
      this.#expect('read1');
      return this.#guard('write2', () => {
        if (msg.length < 32 + 48 + 16) throw new NoiseError('message too short');
        const ss = this.#ss;
        this.#re = Buffer.from(msg.subarray(0, 32));
        ss.mixHash(this.#re);
        ss.mixKey(dh(this.#s.priv, this.#re)); // es
        const rs = ss.decryptAndHash(msg.subarray(32, 80));
        ss.mixKey(dh(this.#s.priv, rs)); // ss
        const payload = ss.decryptAndHash(msg.subarray(80));
        this.#rs = rs;
        return payload;
      });
    }
    this.#expect('read2');
    return this.#guard('done', () => {
      if (msg.length < 32 + 16) throw new NoiseError('message too short');
      const ss = this.#ss;
      this.#re = Buffer.from(msg.subarray(0, 32));
      ss.mixHash(this.#re);
      ss.mixKey(dh(this.#e!.priv, this.#re)); // ee
      ss.mixKey(dh(this.#s.priv, this.#re)); // se
      return ss.decryptAndHash(msg.subarray(32));
    });
  }

  #sized(m: Buffer): Buffer {
    if (m.length > MAX_MESSAGE) throw new NoiseError('message too large');
    return m;
  }

  /** The transport keys, once both messages are through: the initiator sends with the first. */
  split(): { send: CipherState; recv: CipherState } {
    this.#expect('done');
    const [k1, k2] = hkdf(this.#ss.ck, Buffer.alloc(0));
    const c1 = new CipherState(k1), c2 = new CipherState(k2);
    return this.#initiator ? { send: c1, recv: c2 } : { send: c2, recv: c1 };
  }
}
