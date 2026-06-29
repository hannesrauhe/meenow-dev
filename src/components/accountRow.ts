// Shared account-row markup (avatar + name + handle + trailing actions slot),
// mirroring the post-card header in feed.ts. Used by the circle, peer-connections,
// and connect-landing screens.

export function makeAccountRow(account: { displayName: string; handle: string; avatarUrl: string }): {
  row: HTMLElement;
  actions: HTMLElement;
} {
  const row = document.createElement('div');
  row.className = 'flex items-center gap-3 px-4 py-3';

  const avatar = document.createElement('img');
  avatar.src = account.avatarUrl;
  avatar.className = 'w-9 h-9 rounded-full object-cover bg-gold-light shrink-0';
  avatar.alt = '';
  avatar.loading = 'lazy';
  row.appendChild(avatar);

  const info = document.createElement('div');
  info.className = 'flex-1 min-w-0';

  const nameEl = document.createElement('p');
  nameEl.className = 'text-sm font-medium text-ink truncate';
  nameEl.textContent = account.displayName;
  info.appendChild(nameEl);

  const metaEl = document.createElement('p');
  metaEl.className = 'text-xs text-ink/40 truncate';
  metaEl.textContent = `@${account.handle}`;
  info.appendChild(metaEl);

  row.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'shrink-0 flex items-center gap-2';
  row.appendChild(actions);

  return { row, actions };
}
