const SYMBOL_KIND_ICON = {
  function: 'fn',
  class: 'C',
  interface: 'I',
  type: 'T',
  enum: 'E',
  struct: 'S',
  trait: 'R',
  impl: 'i',
  method: 'm',
  variable: 'v',
};

function renderSymbolList(block, collapsed = false, ctx) {
  const symbols = Array.isArray(block.symbols) ? block.symbols : [];
  const path = block.path || 'file';
  const meta = [
    block.language ? `lang: ${block.language}` : '',
    block.symbolCount !== undefined ? `${block.symbolCount} symbol${block.symbolCount === 1 ? '' : 's'}` : '',
    block.totalLines !== undefined ? `${block.totalLines} lines` : '',
    block.truncated ? 'truncated' : '',
  ].filter(Boolean).join(' · ');

  const items = symbols.map(sym => {
    const icon = SYMBOL_KIND_ICON[String(sym.kind).split(' ')[0]] || '·';
    const params = sym.params ? `(${ctx.escHtml(sym.params)})` : '';
    return `
      <li class="symbol-item">
        <span class="symbol-icon">${icon}</span>
        <span class="symbol-kind">${ctx.escHtml(sym.kind || '')}</span>
        <span class="symbol-name">${ctx.escHtml(sym.name || '')}${params}</span>
        <span class="symbol-line">L${Number(sym.line) || '?'}</span>
      </li>
    `;
  }).join('');

  return `
    <div class="shell-command-toggle symbol-list-toggle${collapsed ? ' collapsed' : ''}">
      <div class="shell-command-toggle-header" data-toggle-parent>
        <span class="shell-command-toggle-label">
          <span class="shell-command-icon">⌘</span>
          ${ctx.escHtml(path)}
        </span>
        <span class="shell-command-meta">${ctx.escHtml(meta)}</span>
        <span class="shell-command-toggle-arrow">&#9662;</span>
      </div>
      <div class="shell-command-toggle-body">
        <ul class="symbol-list">${items || '<li class="symbol-empty">(no symbols found)</li>'}</ul>
      </div>
    </div>
  `;
}

export const renderType = 'symbol-list';

export function renderBlock(block, collapsed, ctx) {
  return renderSymbolList(block, block.collapsed ?? collapsed, ctx);
}
