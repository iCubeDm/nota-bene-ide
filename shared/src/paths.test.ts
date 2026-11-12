import { describe, expect, it } from 'vitest';
import { basename, dirname, isAbsPath, isInside, toSlash } from './paths.ts';

describe('isAbsPath', () => {
  it.each(['/', '/a/b', 'C:\\', 'c:/x', 'Z:\\a b', '\\\\host\\share', '\\\\?\\C:\\a', '//host/share'])('%s is absolute', (p) => {
    expect(isAbsPath(p)).toBe(true);
  });
  it.each(['', 'a', 'a/b', 'src\\a.ts', 'C:', 'C:x', './a', '..\\a', '~/a', '1:/a'])('%s is not', (p) => {
    expect(isAbsPath(p)).toBe(false);
  });
});

describe('toSlash', () => {
  it.each([
    ['C:\\Users\\x\\proj', 'C:/Users/x/proj'],
    ['c:\\users\\x\\', 'C:/users/x'],
    ['c:\\', 'C:/'],
    ['C:/', 'C:/'],
    ['C:\\\\a\\\\\\b', 'C:/a/b'],
    ['\\\\host\\share\\dir\\', '//host/share/dir'],
    ['\\\\host\\share', '//host/share'],
    ['\\\\?\\c:\\a\\b', '//?/C:/a/b'],
    ['/', '/'],
    ['/a//b/', '/a/b'],
    ['src\\a.ts', 'src/a.ts'],
    ['./a/../b', './a/../b'],
    ['', ''],
  ])('%s → %s', (p, out) => {
    expect(toSlash(p)).toBe(out);
  });
});

describe('basename', () => {
  it.each([
    ['/a/b.ts', 'b.ts'],
    ['C:\\a\\b.ts', 'b.ts'],
    ['C:\\a\\dir\\', 'dir'],
    ['src/x\\y.ts', 'y.ts'],
    ['name', 'name'],
    ['/', ''],
    ['C:\\', ''],
    ['', ''],
  ])('%s → %s', (p, out) => {
    expect(basename(p)).toBe(out);
  });
});

describe('dirname', () => {
  it.each([
    ['/a/b', '/a'],
    ['/a', '/'],
    ['/', '/'],
    ['C:\\a\\b.ts', 'C:/a'],
    ['c:\\a', 'C:/'],
    ['C:\\', 'C:/'],
    ['\\\\host\\share\\x', '//host/share'],
    ['\\\\host\\share', '//host/share'],
    ['\\\\?\\C:\\a', '//?/C:/'],
    ['src\\a.ts', 'src'],
    ['a.ts', '.'],
    ['a/b/', 'a'],
  ])('%s → %s', (p, out) => {
    expect(dirname(p)).toBe(out);
  });
});

describe('isInside', () => {
  it.each([
    ['/a/b/c', '/a/b'],
    ['/a/b', '/a/b/'],
    ['/a/b', '/'],
    ['C:\\proj\\src\\a.ts', 'C:/proj'],
    ['c:/proj/x', 'C:\\proj'], // the drive letter is case-insensitive anyway
    ['C:\\a', 'C:\\'],
    ['\\\\h\\s\\x', '//h/s'],
    ['/a/b/./c/../d', '/a/b'],
    ['src/a.ts', 'src'],
    ['src/a.ts', '.'],
  ])('%s is inside %s', (c, p) => {
    expect(isInside(c, p)).toBe(true);
  });

  it.each([
    ['/a/bc', '/a/b'],
    ['/a', '/a/b'],
    ['/a/b/../c', '/a/b'],
    ['/a/b/../../../etc', '/a/b'],
    ['C:\\proj2', 'C:\\proj'],
    ['D:\\proj\\x', 'C:\\proj'],
    ['C:\\Proj\\x', 'C:\\proj'],
    ['//h/s2/x', '//h/s'],
    ['../a', '.'],
    ['/a', '.'],
  ])('%s is not inside %s', (c, p) => {
    expect(isInside(c, p)).toBe(false);
  });

  it('ignores case when asked', () => {
    expect(isInside('C:\\Proj\\X', 'c:/proj', { caseInsensitive: true })).toBe(true);
    expect(isInside('C:\\Proj2', 'c:/proj', { caseInsensitive: true })).toBe(false);
    expect(isInside('/A/b', '/a', { caseInsensitive: false })).toBe(false);
  });
});
