import { submitMessageFromInput } from './file-mention-controller.js';
import { dom } from '../dom.js';
import { stopActiveStream } from '../chat-stream.js';
import { getActiveStream } from '../stores/app-store.js';

export function bindChatInputController() {
  dom.btnSend.addEventListener('click', () => {
    if (getActiveStream()) {
      stopActiveStream();
      return;
    }
    submitMessageFromInput();
  });

  dom.msgInput.addEventListener('input', () => {
    dom.msgInput.style.height = 'auto';
    dom.msgInput.style.height = Math.min(dom.msgInput.scrollHeight, 200) + 'px';
  });
}
