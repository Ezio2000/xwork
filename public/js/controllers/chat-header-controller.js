import { dom } from '../dom.js';
import {
  installToolHeaderActionHandlers,
  renderToolHeaderActions,
} from '../tool-ui-registry.js';

let headerHandlersInstalled = false;

export function renderChatHeaderActions() {
  const root = dom.chatHeaderActions;
  if (!root) return;
  root.innerHTML = renderToolHeaderActions();
}

export function bindChatHeaderController() {
  renderChatHeaderActions();
  if (headerHandlersInstalled || !dom.chatHeaderActions) return;
  headerHandlersInstalled = true;
  installToolHeaderActionHandlers(dom.chatHeaderActions, {
    renderChatHeaderActions,
  });
}
