import { api } from './api-client.js';
import { dom } from './dom.js';
import { escHtml } from './renderers.js';
import { state } from './state.js';

const MAX_IMAGES = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read image'));
    reader.readAsDataURL(file);
  });
}

function formatSize(bytes) {
  const n = Number(bytes || 0);
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function renderImageAttachments() {
  const images = state.pendingImages || [];
  dom.imageAttachments.hidden = images.length === 0;
  dom.imageAttachments.innerHTML = images.map(image => `
    <div class="image-attachment" data-image-id="${escHtml(image.id)}">
      <img src="${escHtml(image.url)}" alt="${escHtml(image.filename || 'image')}">
      <div class="image-attachment-meta">
        <span>${escHtml(image.filename || image.id)}</span>
        <small>${escHtml(image.mediaType || 'image')} · ${escHtml(formatSize(image.size))}</small>
      </div>
      <button type="button" class="image-attachment-remove" title="Remove image" aria-label="Remove image">×</button>
    </div>
  `).join('');
}

export async function addImageFiles(files) {
  const incoming = [...files].filter(Boolean);
  if (!incoming.length) return;
  const current = state.pendingImages || [];
  if (current.length + incoming.length > MAX_IMAGES) {
    alert(`最多一次发送 ${MAX_IMAGES} 张图片`);
    return;
  }

  for (const file of incoming) {
    if (!ALLOWED_TYPES.has(file.type)) {
      alert(`不支持的图片类型：${file.type || file.name}`);
      continue;
    }
    if (file.size > MAX_BYTES) {
      alert(`${file.name} 超过 10MB`);
      continue;
    }
    const dataUrl = await fileToDataUrl(file);
    const asset = await api('POST', '/api/v1/images', {
      filename: file.name,
      dataUrl,
    });
    state.pendingImages.push(asset);
    renderImageAttachments();
  }
}

export function clearPendingImages() {
  state.pendingImages = [];
  renderImageAttachments();
}

export function pendingImageRefs() {
  return (state.pendingImages || []).map(image => ({ id: image.id }));
}

export function bindImageAttachments() {
  dom.btnImageUpload.addEventListener('click', () => dom.imageUploadInput.click());
  dom.imageUploadInput.addEventListener('change', async () => {
    try {
      await addImageFiles(dom.imageUploadInput.files || []);
    } catch (err) {
      alert(err.message || String(err));
    } finally {
      dom.imageUploadInput.value = '';
    }
  });

  dom.imageAttachments.addEventListener('click', (event) => {
    const button = event.target.closest('.image-attachment-remove');
    if (!button) return;
    const item = button.closest('.image-attachment');
    const id = item?.dataset.imageId;
    state.pendingImages = (state.pendingImages || []).filter(image => image.id !== id);
    renderImageAttachments();
  });

  dom.msgInput.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])].filter(file => file.type?.startsWith('image/'));
    if (!files.length) return;
    addImageFiles(files).catch(err => alert(err.message || String(err)));
  });

  dom.msgInput.addEventListener('dragover', (event) => {
    if ([...(event.dataTransfer?.items || [])].some(item => item.type?.startsWith('image/'))) {
      event.preventDefault();
    }
  });
  dom.msgInput.addEventListener('drop', (event) => {
    const files = [...(event.dataTransfer?.files || [])].filter(file => file.type?.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    addImageFiles(files).catch(err => alert(err.message || String(err)));
  });
}
