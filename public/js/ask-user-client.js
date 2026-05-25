import { api } from './api-client.js';

export async function submitAskUserInput(runId, toolCallId, response) {
  return api('POST', `/api/v1/chat-runs/${encodeURIComponent(runId)}/user-input`, {
    toolCallId,
    response,
  });
}

export function collectAskUserResponseFromForm(form) {
  const kind = form.dataset.kind || 'text';
  if (kind === 'confirm' || kind === 'single') {
    const selected = form.querySelector('input[name="ask-answer"]:checked');
    const custom = form.querySelector('[data-ask-custom]');
    if (selected?.value === '__custom__' && custom) {
      return { status: 'answered', answer: custom.value.trim(), customText: custom.value.trim() };
    }
    if (selected) return { status: 'answered', answer: selected.value };
    throw new Error('请选择一个选项');
  }
  if (kind === 'multi') {
    const checked = [...form.querySelectorAll('input[name="ask-answers"]:checked')].map(el => el.value);
    if (!checked.length) throw new Error('请至少选择一项');
    return { status: 'answered', answers: checked };
  }
  if (kind === 'number') {
    const input = form.querySelector('[data-ask-number]');
    if (!input || input.value === '') throw new Error('请输入数字');
    return { status: 'answered', answer: Number(input.value) };
  }
  if (kind === 'form') {
    const values = {};
    for (const field of form.querySelectorAll('[data-ask-field]')) {
      const name = field.dataset.askField;
      if (field.type === 'checkbox' && field.dataset.fieldType === 'boolean') {
        values[name] = field.checked;
      } else if (field.type === 'checkbox' && field.dataset.fieldType === 'multiselect') {
        if (!values[name]) values[name] = [];
        if (field.checked) values[name].push(field.value);
      } else if (field.type === 'checkbox') {
        if (field.checked) {
          if (!values[name]) values[name] = [];
          values[name].push(field.value);
        }
      } else if (field.value !== '') {
        values[name] = field.type === 'number' ? Number(field.value) : field.value;
      }
    }
    return { status: 'answered', values };
  }
  const textInput = form.querySelector('[data-ask-text]');
  if (!textInput || !textInput.value.trim()) throw new Error('请输入内容');
  return { status: 'answered', answer: textInput.value.trim() };
}

export function markAskUserFormSubmitting(form, message = '已提交，等待继续…') {
  form.dataset.submitting = '1';
  const actions = form.querySelector('.ask-user-actions');
  if (actions) {
    actions.querySelectorAll('button').forEach(btn => { btn.disabled = true; });
    let note = form.querySelector('.ask-user-submit-note');
    if (!note) {
      note = document.createElement('p');
      note.className = 'ask-user-submit-note';
      actions.appendChild(note);
    }
    note.textContent = message;
  }
}

export function markAskUserFormError(form, message) {
  form.dataset.submitting = '0';
  const actions = form.querySelector('.ask-user-actions');
  if (actions) {
    actions.querySelectorAll('button').forEach(btn => { btn.disabled = false; });
    let note = form.querySelector('.ask-user-submit-note');
    if (!note) {
      note = document.createElement('p');
      note.className = 'ask-user-submit-note ask-user-error';
      actions.appendChild(note);
    }
    note.textContent = message;
  }
}
