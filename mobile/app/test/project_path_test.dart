import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/files.dart';

void main() {
  test('a project path has no ./ prefix', () {
    expect(projectPath('/home/u/p', './src/a.ts'), 'src/a.ts');
    expect(projectPath('/home/u/p', '/home/u/p/./src/a.ts'), 'src/a.ts');
    expect(projectPath('/home/u/p', 'src/a.ts'), 'src/a.ts');
    expect(projectPath('/home/u/p', '/elsewhere/a.ts'), isNull);
    expect(projectPath('/home/u/p', './../a.ts'), isNull);
  });
}
