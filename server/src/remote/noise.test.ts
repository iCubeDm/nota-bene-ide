import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CipherState, dh, generateKeyPair, Handshake, MAX_PLAINTEXT, NoiseError, PROLOGUE, publicOf, type KeyPair } from './noise.ts';

type Vector = {
  protocol_name: string;
  init_prologue: string;
  init_static: string;
  init_ephemeral: string;
  init_remote_static: string;
  resp_static: string;
  resp_ephemeral: string;
  handshake_hash?: string;
  messages: { payload: string; ciphertext: string }[];
};
const file = JSON.parse(fs.readFileSync(new URL('./noise-vectors.json', import.meta.url), 'utf8')) as { vectors: Vector[] };
const hex = (s: string) => Buffer.from(s, 'hex');
const pair = (priv: string): KeyPair => ({ priv: hex(priv), pub: publicOf(hex(priv)) });

describe('noise', () => {
  it('vectors: every IK_25519_ChaChaPoly_SHA256 entry', () => {
    expect(file.vectors.length).toBeGreaterThan(0);
    for (const v of file.vectors) {
      expect(v.protocol_name).toBe('Noise_IK_25519_ChaChaPoly_SHA256');
      const resp = pair(v.resp_static);
      expect(publicOf(resp.priv).equals(hex(v.init_remote_static))).toBe(true);
      const ini = Handshake.initiator({ s: pair(v.init_static), rs: hex(v.init_remote_static), prologue: hex(v.init_prologue), e: pair(v.init_ephemeral) });
      const res = Handshake.responder({ s: resp, prologue: hex(v.init_prologue), e: pair(v.resp_ephemeral) });
      let iSend: CipherState | undefined, iRecv: CipherState | undefined, rSend: CipherState | undefined, rRecv: CipherState | undefined;
      v.messages.forEach((m, i) => {
        const fromInit = i % 2 === 0;
        let ct: Buffer, pt: Buffer;
        if (i < 2) {
          ct = (fromInit ? ini : res).writeMessage(hex(m.payload));
          pt = (fromInit ? res : ini).readMessage(ct);
          if (i === 1) {
            ({ send: iSend, recv: iRecv } = ini.split());
            ({ send: rSend, recv: rRecv } = res.split());
            if (v.handshake_hash) {
              expect(ini.handshakeHash.toString('hex')).toBe(v.handshake_hash);
              expect(res.handshakeHash.toString('hex')).toBe(v.handshake_hash);
            }
          }
        } else {
          ct = (fromInit ? iSend : rSend)!.encrypt(hex(m.payload));
          pt = (fromInit ? rRecv : iRecv)!.decrypt(ct);
        }
        expect(ct.toString('hex')).toBe(m.ciphertext);
        expect(pt.toString('hex')).toBe(m.payload);
      });
    }
  });

  const handshake = () => {
    const is = generateKeyPair(), rs = generateKeyPair();
    const ini = Handshake.initiator({ s: is, rs: rs.pub, prologue: PROLOGUE });
    const res = Handshake.responder({ s: rs, prologue: PROLOGUE });
    return { is, rs, ini, res };
  };

  it('round trip with fresh keys', () => {
    const { is, ini, res } = handshake();
    expect(res.readMessage(ini.writeMessage(Buffer.from('hello'))).toString()).toBe('hello');
    expect(res.remoteStatic!.equals(is.pub)).toBe(true);
    expect(ini.readMessage(res.writeMessage(Buffer.from('ok'))).toString()).toBe('ok');
    const a = ini.split(), b = res.split();
    for (let i = 0; i < 3; i++) {
      expect(b.recv.decrypt(a.send.encrypt(Buffer.from(`up${i}`))).toString()).toBe(`up${i}`);
      expect(a.recv.decrypt(b.send.encrypt(Buffer.from(`down${i}`))).toString()).toBe(`down${i}`);
    }
    expect(ini.handshakeHash.equals(res.handshakeHash)).toBe(true);
  });

  it('a flipped bit fails', () => {
    const { ini, res } = handshake();
    const m1 = ini.writeMessage(Buffer.from('x'));
    const bad = Buffer.from(m1);
    bad[40]! ^= 1;
    expect(() => res.readMessage(bad)).toThrow(NoiseError);

    const h = handshake();
    h.ini.readMessage(h.res.writeMessage((h.res.readMessage(h.ini.writeMessage(Buffer.alloc(0))), Buffer.alloc(0))));
    const a = h.ini.split(), b = h.res.split();
    const c1 = a.send.encrypt(Buffer.from('one'));
    const c2 = a.send.encrypt(Buffer.from('two'));
    c1[0]! ^= 1;
    expect(() => b.recv.decrypt(c1)).toThrow(NoiseError);
    expect(() => b.recv.decrypt(c2)).toThrow(NoiseError);
  });

  it('wrong pinned key fails', () => {
    const is = generateKeyPair(), rs = generateKeyPair(), other = generateKeyPair();
    const ini = Handshake.initiator({ s: is, rs: other.pub, prologue: PROLOGUE });
    const res = Handshake.responder({ s: rs, prologue: PROLOGUE });
    expect(() => res.readMessage(ini.writeMessage(Buffer.from('x')))).toThrow(NoiseError);
  });

  it('a different prologue fails', () => {
    const is = generateKeyPair(), rs = generateKeyPair();
    const ini = Handshake.initiator({ s: is, rs: rs.pub, prologue: PROLOGUE });
    const res = Handshake.responder({ s: rs, prologue: Buffer.from('other') });
    expect(() => res.readMessage(ini.writeMessage(Buffer.from('x')))).toThrow(NoiseError);
  });

  it('low-order public key is refused', () => {
    expect(() => dh(generateKeyPair().priv, Buffer.alloc(32))).toThrow();
  });

  it('oversized', () => {
    const { ini, res } = handshake();
    ini.readMessage(res.writeMessage((res.readMessage(ini.writeMessage(Buffer.alloc(0))), Buffer.alloc(0))));
    const { send } = ini.split();
    expect(() => send.encrypt(Buffer.alloc(MAX_PLAINTEXT + 1))).toThrow(NoiseError);
    expect(send.encrypt(Buffer.alloc(MAX_PLAINTEXT)).length).toBe(65535);
  });

  it('messages out of order are refused', () => {
    const { ini, res } = handshake();
    expect(() => ini.readMessage(Buffer.alloc(48))).toThrow(NoiseError);
    expect(() => res.writeMessage(Buffer.alloc(0))).toThrow(NoiseError);
    expect(() => ini.split()).toThrow(NoiseError);
  });
});
