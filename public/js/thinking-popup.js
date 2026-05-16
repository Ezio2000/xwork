let thinkingPopup = null;
let thinkingPopupTimer = null;

function ensureThinkingPopup() {
  if (thinkingPopup) return thinkingPopup;
  thinkingPopup = document.createElement('div');
  thinkingPopup.id = 'thinking-popup';
  thinkingPopup.className = 'hidden';
  thinkingPopup.innerHTML = '<div class="thinking-popup-content"></div>';
  document.body.appendChild(thinkingPopup);
  return thinkingPopup;
}

export function showThinkingPopup(text) {
  const popup = ensureThinkingPopup();
  const contentEl = popup.querySelector('.thinking-popup-content');
  popup.classList.remove('hidden');
  contentEl.textContent = text;
  contentEl.scrollTop = contentEl.scrollHeight;
  clearTimeout(thinkingPopupTimer);
}

export function hideThinkingPopup() {
  if (!thinkingPopup) return;
  thinkingPopup.classList.add('hidden');
  clearTimeout(thinkingPopupTimer);
}
