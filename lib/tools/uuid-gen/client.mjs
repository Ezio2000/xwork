function markCopied(button, label) {
  button.textContent = 'Copied!';
  setTimeout(() => { button.textContent = label; }, 1200);
}

export function installHandlers(root) {
  root.addEventListener('click', (event) => {
    const copyOne = event.target.closest('[data-copy-uuid]');
    if (copyOne) {
      event.preventDefault();
      navigator.clipboard.writeText(copyOne.dataset.copyUuid).then(() => {
        markCopied(copyOne, 'Copy');
      }).catch(() => {});
      return;
    }

    const copyAll = event.target.closest('[data-copy-uuids]');
    if (copyAll) {
      event.preventDefault();
      try {
        const uuids = JSON.parse(copyAll.dataset.copyUuids);
        navigator.clipboard.writeText(uuids.join('\n')).then(() => {
          markCopied(copyAll, 'Copy all');
        }).catch(() => {});
      } catch {}
    }
  });
}
