// Shared account-row markup (avatar + name + handle + trailing actions slot),
// mirroring the post-card header in feed.ts. Used by the circle screen.

// Instances often keep serving an unchanged avatar URL after a picture change,
// so the browser HTTP cache would pin the old bytes forever. A daily bucket
// revalidates each avatar at most once a day.
export function avatarSrc(url: string): string {
  if (!url || url.startsWith('data:')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${Math.floor(Date.now() / 86_400_000)}`;
}

export function makeAccountRow(account: {
  displayName: string;
  handle: string;
  avatarUrl: string;
  profileUrl?: string;
}): {
  row: HTMLElement;
  actions: HTMLElement;
} {
  const row = document.createElement('div');
  row.className = 'flex items-center gap-3 px-4 py-3';

  const avatar = document.createElement('img');
  avatar.src = avatarSrc(account.avatarUrl);
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

  if (account.profileUrl) {
    const url = account.profileUrl;
    row.classList.add('cursor-pointer');
    row.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
    actions.addEventListener('click', e => e.stopPropagation());
  }

  return { row, actions };
}
