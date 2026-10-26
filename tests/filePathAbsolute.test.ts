import { isAbsoluteFilePath } from '../src/components/file-manager/filePathNav.js';

for (const path of [
  '/', '/home/deploy/project', '/tmp/a\\b',
  'C:\\', 'C:\\Users\\gajen', 'D:/projects/zync',
  '\\\\server\\share', '\\\\server\\share\\folder',
  '\\\\wsl.localhost\\Ubuntu\\home\\gajen',
]) {
  if (!isAbsoluteFilePath(path)) throw new Error(`Expected an absolute Files path: ${JSON.stringify(path)}`);
}

for (const path of [
  '', '.', '..', './folder', '../folder', 'folder', 'folder/child',
  'folder\\child', '~', '~/project', '~user/project',
  'C:', 'C:folder', 'C:folder\\child', '\\Windows', ' /home/deploy',
]) {
  if (isAbsoluteFilePath(path)) throw new Error(`Expected an unresolved or relative Files path: ${JSON.stringify(path)}`);
}

console.log('Files absolute-path regressions passed.');
