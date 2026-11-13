import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetSession, lastSession, saveSession, SecretError, sharedHomeRefusal, stateDir } from './state.ts';

let home: string;
const prevHome = process.env.NOTA_BENE_HOME;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-state-'));
  process.env.NOTA_BENE_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('state', () => {
  it('saves then reads a session id', () => {
    saveSession('/p', 'abc');
    expect(lastSession('/p')).toBe('abc');
  });
  it('forgetSession drops every project whose last session it was, and only those', () => {
    saveSession('/p', 'gone');
    saveSession('/q', 'gone');
    saveSession('/r', 'kept');
    expect(forgetSession('gone')).toBe(2);
    expect([lastSession('/p'), lastSession('/q'), lastSession('/r')]).toEqual([undefined, undefined, 'kept']);
    expect(forgetSession('gone')).toBe(0);
  });
  it('null deletes the entry', () => {
    saveSession('/p', 'abc');
    saveSession('/p', null);
    expect(lastSession('/p')).toBeUndefined();
  });
  it('corrupt sessions.json yields undefined without throwing', () => {
    fs.writeFileSync(path.join(stateDir(), 'sessions.json'), '{');
    expect(lastSession('/p')).toBeUndefined();
  });
  it('leaves no sessions.json.tmp* after a save', () => {
    saveSession('/p', 'abc');
    expect(fs.readdirSync(home).filter((f) => f.startsWith('sessions.json.tmp'))).toEqual([]);
  });
});

describe('Windows: a state folder outside the user profile is refused (its default ACL lets other users read the token)', () => {
  const profile = 'C:\\Users\\someone';
  it('inside the profile, in any case or separator, is fine', () => {
    expect(sharedHomeRefusal('C:\\Users\\someone\\.nota-bene', profile, {})).toBeNull();
    expect(sharedHomeRefusal('c:/users/SOMEONE/AppData/Local/Temp/x', profile, {})).toBeNull();
    expect(sharedHomeRefusal(profile, profile, {})).toBeNull();
  });
  it('outside it is refused with what to do, never chmod; NOTA_BENE_ALLOW_SHARED_HOME=1 allows it', () => {
    for (const dir of ['D:\\state', 'C:\\nb', 'C:\\Users\\someone2\\.nota-bene', 'C:\\Users\\Public\\nb']) {
      const why = sharedHomeRefusal(dir, profile, {});
      expect(why).toContain(dir);
      expect(why).toMatch(/NOTA_BENE_HOME/);
      expect(why).toMatch(/NOTA_BENE_ALLOW_SHARED_HOME=1/);
      expect(why).not.toMatch(/chmod/);
      expect(sharedHomeRefusal(dir, profile, { NOTA_BENE_ALLOW_SHARED_HOME: '1' })).toBeNull();
      expect(sharedHomeRefusal(dir, profile, { NOTA_BENE_ALLOW_SHARED_HOME: 'yes' })).not.toBeNull();
    }
  });

  describe.runIf(process.platform === 'win32')('stateDir', () => {
    const prev = { profile: process.env.USERPROFILE, allow: process.env.NOTA_BENE_ALLOW_SHARED_HOME };
    afterEach(() => {
      process.env.USERPROFILE = prev.profile;
      if (prev.allow === undefined) delete process.env.NOTA_BENE_ALLOW_SHARED_HOME; else process.env.NOTA_BENE_ALLOW_SHARED_HOME = prev.allow;
    });
    it('refuses NOTA_BENE_HOME outside %USERPROFILE% unless allowed; the default place is inside it', () => {
      // a profile that does not contain the (temporary) state folder: a sibling of it
      const fake = path.join(home, '..', `${path.basename(home)}-profile`);
      fs.mkdirSync(fake, { recursive: true });
      try {
        process.env.USERPROFILE = fake.toUpperCase();
        delete process.env.NOTA_BENE_ALLOW_SHARED_HOME;
        expect(() => stateDir()).toThrow(SecretError);
        expect(() => stateDir()).toThrow(/outside your user profile/);
        process.env.NOTA_BENE_ALLOW_SHARED_HOME = '1';
        expect(stateDir()).toBe(home);
        // in the profile, spelled in another case: fine
        process.env.USERPROFILE = path.dirname(home).toLowerCase();
        delete process.env.NOTA_BENE_ALLOW_SHARED_HOME;
        process.env.NOTA_BENE_HOME = path.join(home, 'inner');
        expect(stateDir()).toBe(path.join(home, 'inner'));
      } finally {
        fs.rmSync(fake, { recursive: true, force: true });
      }
    });
  });
});
