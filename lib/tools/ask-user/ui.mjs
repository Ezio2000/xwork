function renderAskUserOptions(block, runId, ctx) {
  const options = Array.isArray(block.options) ? block.options : [];
  const recommended = block.recommended;
  const allowCustom = block.allowCustom === true;
  const inputType = block.kind === 'multi' ? 'checkbox' : 'radio';
  const name = block.kind === 'multi' ? 'ask-answers' : 'ask-answer';
  const items = options.map(opt => {
    const value = typeof opt === 'string' ? opt : (opt.value || opt.label || '');
    const label = typeof opt === 'string' ? opt : (opt.label || value);
    const desc = typeof opt === 'object' && opt.description ? `<span class="ask-user-option-desc">${ctx.escHtml(opt.description)}</span>` : '';
    const rec = recommended && value === recommended ? ' ask-user-option-recommended' : '';
    const checked = block.default === value || (Array.isArray(block.default) && block.default.includes(value)) ? ' checked' : '';
    return `
      <label class="ask-user-option${rec}">
        <input type="${inputType}" name="${name}" value="${ctx.escHtml(value)}"${checked}>
        <span class="ask-user-option-label">${ctx.escHtml(label)}</span>
        ${desc}
      </label>
    `;
  }).join('');
  const custom = allowCustom && block.kind === 'single' ? `
    <label class="ask-user-option">
      <input type="radio" name="ask-answer" value="__custom__">
      <span class="ask-user-option-label">其他</span>
      <input type="text" class="ask-user-custom-input" data-ask-custom placeholder="自定义…">
    </label>
  ` : '';
  return `<div class="ask-user-options">${items}${custom}</div>`;
}

function renderAskUserFields(block, ctx) {
  const fields = Array.isArray(block.fields) ? block.fields : [];
  return fields.map(field => {
    const name = ctx.escHtml(field.name || '');
    const label = ctx.escHtml(field.label || field.name || '');
    const req = field.required ? ' <span class="ask-user-required">*</span>' : '';
    const desc = field.description ? `<p class="ask-user-field-desc">${ctx.escHtml(field.description)}</p>` : '';
    const ph = field.placeholder ? ` placeholder="${ctx.escHtml(field.placeholder)}"` : '';
    let control = '';
    if (field.type === 'boolean') {
      control = `<label class="ask-user-field-bool"><input type="checkbox" data-ask-field="${name}" data-field-type="boolean"${field.default ? ' checked' : ''}> ${label}</label>`;
    } else if (field.type === 'select') {
      const opts = (field.options || []).map(opt => {
        const v = typeof opt === 'string' ? opt : opt.value;
        const l = typeof opt === 'string' ? opt : (opt.label || v);
        return `<option value="${ctx.escHtml(v)}"${field.default === v ? ' selected' : ''}>${ctx.escHtml(l)}</option>`;
      }).join('');
      control = `<label class="ask-user-field-label">${label}${req}</label><select data-ask-field="${name}" data-field-type="select"${ph}>${opts}</select>`;
    } else if (field.type === 'multiselect') {
      const opts = (field.options || []).map(opt => {
        const v = typeof opt === 'string' ? opt : opt.value;
        const l = typeof opt === 'string' ? opt : (opt.label || v);
        return `<label class="ask-user-option"><input type="checkbox" data-ask-field="${name}" data-field-type="multiselect" value="${ctx.escHtml(v)}"> ${ctx.escHtml(l)}</label>`;
      }).join('');
      control = `<div class="ask-user-field-group"><span class="ask-user-field-label">${label}${req}</span>${opts}</div>`;
    } else if (field.type === 'number') {
      const min = field.min !== undefined ? ` min="${field.min}"` : '';
      const max = field.max !== undefined ? ` max="${field.max}"` : '';
      control = `<label class="ask-user-field-label">${label}${req}</label><input type="number" data-ask-field="${name}" data-field-type="number"${ph}${min}${max} value="${field.default ?? ''}">`;
    } else {
      const sensitive = field.sensitive ? ' autocomplete="off"' : '';
      control = `<label class="ask-user-field-label">${label}${req}</label><input type="${field.sensitive ? 'password' : 'text'}" data-ask-field="${name}" data-field-type="text"${ph}${sensitive} value="${ctx.escHtml(String(field.default ?? ''))}">`;
    }
    return `<div class="ask-user-field">${control}${desc}</div>`;
  }).join('');
}

function formatAskUserAnswer(block) {
  if (block.status === 'skipped') return `已跳过${block.reason ? `（${block.reason}）` : ''}`;
  if (block.status === 'cancelled') return '已取消';
  if (block.kind === 'multi' && Array.isArray(block.answers)) return block.answers.join(', ');
  if (block.kind === 'form' && block.values) {
    return Object.entries(block.values).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ');
  }
  if (block.answer !== undefined && block.answer !== null) return String(block.answer);
  return '';
}

function renderAskUser(block, collapsed = false, ctx) {
  const waiting = block.status === 'waiting';
  const answered = block.status === 'answered' || block.status === 'skipped';
  const runId = block.runId || '';
  const toolCallId = block.toolCallId || '';
  const kind = block.kind || 'text';
  const contextHtml = block.context
    ? `<div class="ask-user-context">${ctx.renderContent(block.context)}</div>`
    : '';

  if (!waiting) {
    const answerText = formatAskUserAnswer(block);
    const statusLabel = block.status === 'skipped' ? '已跳过' : block.status === 'error' ? '失败' : '已回答';
    return `
      <div class="ask-user-block ask-user-${ctx.escHtml(block.status || 'answered')}${collapsed ? ' collapsed' : ''}">
        <div class="ask-user-header">
          <span class="ask-user-badge">${ctx.escHtml(statusLabel)}</span>
          <span class="ask-user-question">${ctx.escHtml(block.question || '')}</span>
        </div>
        ${contextHtml}
        ${answerText ? `<div class="ask-user-answer-summary"><strong>回答：</strong> ${ctx.escHtml(answerText)}</div>` : ''}
      </div>
    `;
  }

  let body = '';
  let actions = '';
  if (kind === 'confirm') {
    const yes = block.options?.[0]?.label || '是';
    const no = block.options?.[1]?.label || '否';
    actions = `
      <div class="ask-user-actions">
        <button type="button" class="btn-primary" data-ask-action="answer" data-ask-value="yes">${ctx.escHtml(yes)}</button>
        <button type="button" class="btn-text" data-ask-action="answer" data-ask-value="no">${ctx.escHtml(no)}</button>
        ${block.allowSkip !== false ? '<button type="button" class="btn-text ask-user-skip" data-ask-action="skip">跳过</button>' : ''}
      </div>
    `;
  } else if (kind === 'single' || kind === 'multi') {
    body = renderAskUserOptions(block, runId, ctx);
  } else if (kind === 'form') {
    body = `<div class="ask-user-fields">${renderAskUserFields(block, ctx)}</div>`;
  } else if (kind === 'number') {
    const min = block.min !== undefined ? ` min="${block.min}"` : '';
    const max = block.max !== undefined ? ` max="${block.max}"` : '';
    body = `<input type="number" class="ask-user-text-input" data-ask-number${min}${max} placeholder="${ctx.escHtml(block.placeholder || '')}" value="${block.default ?? ''}">`;
  } else {
    const multiline = block.multiline !== false;
    body = multiline
      ? `<textarea class="ask-user-text-input" data-ask-text rows="4" placeholder="${ctx.escHtml(block.placeholder || '输入回答…')}">${ctx.escHtml(String(block.default ?? ''))}</textarea>`
      : `<input type="text" class="ask-user-text-input" data-ask-text placeholder="${ctx.escHtml(block.placeholder || '输入回答…')}" value="${ctx.escHtml(String(block.default ?? ''))}">`;
  }

  const skipBtn = block.allowSkip !== false
    ? '<button type="button" class="btn-text ask-user-skip" data-ask-action="skip">跳过</button>'
    : '';
  if (!actions) {
    actions = `
      <div class="ask-user-actions">
        <button type="submit" class="btn-primary ask-user-submit">提交</button>
        ${skipBtn}
      </div>
    `;
  }

  return `
    <form class="ask-user-block ask-user-waiting" data-ask-user-form data-kind="${ctx.escHtml(kind)}" data-run-id="${ctx.escHtml(runId)}" data-tool-call-id="${ctx.escHtml(toolCallId)}">
      <div class="ask-user-header">
        <span class="ask-user-badge">需要你确认</span>
        <span class="ask-user-question">${ctx.escHtml(block.question || '')}</span>
      </div>
      ${contextHtml}
      ${body ? `<div class="ask-user-body">${body}</div>` : ''}
      ${actions}
    </form>
  `;
}

export const renderType = 'ask-user';

export function renderBlock(block, collapsed, ctx) {
  return renderAskUser(block, block.collapsed ?? collapsed, ctx);
}
