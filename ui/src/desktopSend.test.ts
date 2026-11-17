import { describe, it, expect } from 'vitest';
import { parseSendResult, chatLink, newChatLink } from './desktopSend.js';

describe('desktop send', () => {
  it('reads the last line of the script output; anything else is an error', () => {
    expect(parseSendResult('ok\r\n')).toBe('ok');
    expect(parseSendResult('noise\nbusy')).toBe('busy');
    expect(parseSendResult('wrong-chat')).toBe('wrong-chat');
    expect(parseSendResult('')).toBe('error');
    expect(parseSendResult('Exception: boom')).toBe('error');
  });
  it('opens only a chat link built from a local_ session id', () => {
    expect(chatLink('local_ab12cd34-ef56')).toBe('claude://code/continue?session=local_ab12cd34-ef56');
    expect(chatLink('local_x&evil=1')).toBeNull();
    expect(chatLink('../etc')).toBeNull();
  });
  it('a new chat link needs a Windows folder and encodes the prompt', () => {
    expect(newChatLink('C:\\Proj\\a b', 'привет & пока')).toBe('claude://code/new?q=%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82%20%26%20%D0%BF%D0%BE%D0%BA%D0%B0&folder=C%3A%5CProj%5Ca%20b');
    expect(newChatLink('/home/me/proj', 'hi')).toBeNull();
  });
});
