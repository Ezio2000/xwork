import { submitMessageFromInput } from './file-mention-controller.js';
import { dom } from '../dom.js';

export function bindChatInputController() {
  dom.btnSend.addEventListener('click', () => submitMessageFromInput());

  dom.msgInput.addEventListener('input', () => {
    dom.msgInput.style.height = 'auto';
    dom.msgInput.style.height = Math.min(dom.msgInput.scrollHeight, 200) + 'px';
  });
}
