import { sendMessage } from '../chat-stream.js';
import { dom } from '../dom.js';

export function bindChatInputController() {
  dom.btnSend.addEventListener('click', () => sendMessage(dom.msgInput.value));

  dom.msgInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage(dom.msgInput.value);
    }
  });

  dom.msgInput.addEventListener('input', () => {
    dom.msgInput.style.height = 'auto';
    dom.msgInput.style.height = Math.min(dom.msgInput.scrollHeight, 200) + 'px';
  });
}
