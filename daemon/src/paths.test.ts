import { describe, it, expect } from 'vitest';
import { toWslPath } from './paths.js';

describe('toWslPath', () => {
  it.each([
    ['C:\\Users\\user\\Мои проекты\\пет', '/mnt/c/Users/user/Мои проекты/пет'],
    ['d:\\work', '/mnt/d/work'],
    ['C:/Users/x', '/mnt/c/Users/x'],
    ['C:\\', '/mnt/c'],
    ['\\\\wsl$\\Ubuntu\\home\\user\\proj', '/home/user/proj'],
    ['\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\my proj', '/home/user/my proj'],
    ['/home/user/proj', '/home/user/proj'],
    ['/mnt/c/Workspace', '/mnt/c/Workspace'],
  ])('%s -> %s', (input, out) => expect(toWslPath(input)).toBe(out));
});
