import { afterEach, expect, it } from 'vitest';
import { folderName, isDrivePath, isServerDrivePath, learnServerSep, serverSep, setServerSep, shortWinHome, slashRel, underDir, wireAbs } from './paths.ts';

it('wireAbs: a drive path in the slash form, a POSIX path untouched', () => {
  expect(wireAbs('c:\\Users\\x\\a.png')).toBe('C:/Users/x/a.png');
  expect(wireAbs('C:/Users/x/')).toBe('C:/Users/x');
  expect(wireAbs('/home/x/a\\b.png')).toBe('/home/x/a\\b.png'); // a backslash is a name character on POSIX
  expect(wireAbs('C:proj')).toBe('C:proj');
});

it('underDir: a drive path ignores letter case, a POSIX one does not; a sibling with the same prefix is not inside', () => {
  expect(underDir('c:/users/X/proj/a.md', 'C:/Users/x/proj')).toBe(true);
  expect(underDir('C:/Users/x/proj', 'C:/Users/x/proj')).toBe(true);
  expect(underDir('C:/Users/x/projx/a.md', 'C:/Users/x/proj')).toBe(false);
  expect(underDir('/P/a.md', '/p')).toBe(false);
  expect(underDir('/p/a.md', '/p')).toBe(true);
});

afterEach(() => setServerSep('/'));

it('serverSep: "/" until the server sends a Windows path in the wire form', () => {
  expect(serverSep()).toBe('/');
  learnServerSep(undefined);
  learnServerSep('proj');
  expect(serverSep()).toBe('/');
  learnServerSep('C:/Users/x/proj');
  expect(serverSep()).toBe('\\');
  learnServerSep('');
  expect(serverSep()).toBe('\\');
  learnServerSep('/home/x/proj');
  expect(serverSep()).toBe('/');
  learnServerSep('//host/share/proj');
  expect(serverSep()).toBe('\\');
});

it('slashRel on a Windows server: Windows separators of a relative path become /, other text stays', () => {
  setServerSep('\\');
  expect(slashRel('src\\a.ts')).toBe('src/a.ts');
  expect(slashRel('..\\docs\\Отчёт 1.md')).toBe('../docs/Отчёт 1.md');
  expect(slashRel('src\\lib\\')).toBe('src/lib/');
  for (const s of ['src/a.ts', 'a.ts', '\\n', 'a\\*b', 'C:\\a\\b', 'x\\', 'a/b\\c']) expect(slashRel(s), s).toBe(s);
});

it('slashRel and isServerDrivePath on a POSIX server: a backslash is a name character, C:/ a relative folder', () => {
  for (const s of ['src\\a.ts', '..\\docs\\b.md', 'src/a.ts']) expect(slashRel(s), s).toBe(s);
  expect(isServerDrivePath('C:/a')).toBe(false);
  expect(isDrivePath('C:/a')).toBe(true);
  setServerSep('\\');
  expect(isServerDrivePath('C:/a')).toBe(true);
  expect(isServerDrivePath('C:a')).toBe(false);
});

it('folderName and shortWinHome', () => {
  expect(folderName('C:/Users/x/proj')).toBe('proj');
  expect(folderName('C:\\Users\\x\\proj\\')).toBe('proj');
  expect(folderName('/Users/x/proj/')).toBe('proj');
  expect(folderName('D:/')).toBe('');
  expect(folderName('/')).toBe('');
  expect(shortWinHome('C:/Users/me/proj')).toBe('~/proj');
  expect(shortWinHome('c:\\users\\me\\proj')).toBe('~/proj');
  expect(shortWinHome('D:/work')).toBe('D:/work');
  expect(shortWinHome('/Users/me/proj')).toBe('/Users/me/proj');
});
