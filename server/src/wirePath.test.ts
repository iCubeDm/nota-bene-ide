import { expect, it } from 'vitest';
import { wirePath } from './wirePath.ts';

it('wirePath: Windows paths in the slash form, POSIX ones untouched', () => {
  expect(wirePath('C:\\Users\\x\\proj', 'win32')).toBe('C:/Users/x/proj');
  expect(wirePath('d:\\', 'win32')).toBe('D:/');
  expect(wirePath('\\\\host\\share\\a', 'win32')).toBe('//host/share/a');
  expect(wirePath('/home/x/a\\b', 'linux')).toBe('/home/x/a\\b'); // a backslash is a name character on POSIX
  expect(wirePath('/Users/x/proj', 'darwin')).toBe('/Users/x/proj');
});
