// Feed screen: main home feed showing today's meenow posts from followed accounts.
import { SLEEPING_CAT, SPEECH_BUBBLE_ICON, GRID_ICON } from '../icons';
import { clearAuth, getAuthState, type AuthState } from '../api/auth';
import { MAX_POSTS_PER_TRIGGER } from '../state';
import { fetchMeenowFeed, type FeedPost } from '../api/pixelfed';
import { getLastTriggerTime, getNextTriggerTime, formatShortDateTime, formatCountdown, formatRelativeTime } from '../timer';

export function renderFeed(onRequestCapture: () => void, postCount: number, onOpenPost: (post: FeedPost) => void, onOpenGrid: () => void): HTMLElement {
  const auth = getAuthState();
  const el = document.createElement('div');
  el.className = 'min-h-dvh flex flex-col bg-cream';
  el.id = 'screen-feed';

  const header = document.createElement('header');
  header.className = 'sticky top-0 z-10 bg-cream/95 backdrop-blur-sm flex items-center justify-between px-5 py-4 border-b border-ink/10';
  const atQuota = postCount >= MAX_POSTS_PER_TRIGGER;
  header.innerHTML = `
    <h1 class="text-xl font-semibold tracking-tight text-ink">meenow</h1>
    <div class="flex items-center gap-3">
      ${!atQuota ? `<button id="btn-post-again" class="text-sm font-semibold text-gold">+ Post</button>` : ''}
      <span id="header-status" class="text-xs text-ink/40">${!atQuota ? `${postCount}/${MAX_POSTS_PER_TRIGGER} posted` : ''}</span>
      <button id="btn-open-grid" class="w-6 h-6 text-ink/50 hover:text-ink transition-colors" aria-label="My Photos">${GRID_ICON}</button>
    </div>
  `;

  if (atQuota) {
    const statusEl = header.querySelector('#header-status')!;
    const nextTrigger = getNextTriggerTime();
    let intervalId: number;
    const updateCountdown = (): void => {
      if (!statusEl.isConnected) { clearInterval(intervalId); return; }
      const ms = nextTrigger.getTime() - Date.now();
      statusEl.textContent = ms > 0 ? `next post in ${formatCountdown(ms)}` : '';
    };
    updateCountdown();
    intervalId = setInterval(updateCountdown, 1000);
  }

  el.appendChild(header);

  const content = document.createElement('div');
  content.id = 'feed-content';
  el.appendChild(content);

  const footer = document.createElement('footer');
  footer.className = 'py-6 text-center text-xs text-ink/25 space-y-2';

  const visibility = document.createElement('p');
  visibility.className = 'text-ink/40';
  visibility.textContent = "Your followers can see today’s posts in meenow and on Pixelfed";
  footer.appendChild(visibility);

  const credit = document.createElement('p');
  credit.innerHTML = `Meenow is an experimental side project by <a href="https://rauhe.eu" target="_blank" rel="noopener noreferrer" class="underline underline-offset-2">Hannes Rauhe</a>`;
  footer.appendChild(credit);

  const period = document.createElement('p');
  const last = getLastTriggerTime();
  const next = getNextTriggerTime();
  period.textContent = `Trigger period: ${formatShortDateTime(last)} → ${formatShortDateTime(next)}`;
  footer.appendChild(period);

  const logoutBtn = document.createElement('button');
  logoutBtn.className = 'text-ink/30 hover:text-ink/60 transition-colors';
  logoutBtn.textContent = 'disconnect';
  logoutBtn.addEventListener('click', () => { clearAuth(); window.location.reload(); });
  footer.appendChild(logoutBtn);

  el.appendChild(footer);

  header.querySelector('#btn-post-again')?.addEventListener('click', onRequestCapture);
  header.querySelector('#btn-open-grid')?.addEventListener('click', onOpenGrid);

  if (auth) loadFeed(content, auth, postCount, onOpenPost);
  return el;
}

async function loadFeed(container: HTMLElement, auth: AuthState, postCount: number, onOpenPost: (post: FeedPost) => void): Promise<void> {

  container.innerHTML = `
    <div class="flex items-center justify-center py-20">
      <div class="w-8 h-8 border-[3px] border-gold/30 border-t-gold rounded-full animate-spin"></div>
    </div>
  `;

  let posts: FeedPost[];
  try {
    posts = await fetchMeenowFeed(auth);
  } catch {
    container.innerHTML = `
      <div class="flex flex-col items-center py-16 gap-3 text-center px-6">
        <p class="text-sm text-ink/50">Could not load the feed.</p>
        <button id="btn-feed-retry" class="text-sm text-gold underline underline-offset-2">Retry</button>
      </div>
    `;
    container.querySelector('#btn-feed-retry')?.addEventListener('click', () => loadFeed(container, auth, postCount, onOpenPost));
    return;
  }

  container.innerHTML = '';

  if (posts.length === 0) {
    container.innerHTML = `
      <div class="flex flex-col items-center py-16 gap-4 text-ink/40 text-center px-6">
        <div class="w-36 h-24">${SLEEPING_CAT}</div>
        <p class="text-sm">No meenow posts from friends yet today.</p>
      </div>
    `;
    return;
  }

  const unblurred = postCount > 0;
  posts.forEach(post => container.appendChild(makePostCard(post, unblurred, onOpenPost)));
}

function makePostCard(post: FeedPost, unblurred: boolean, onOpenPost: (post: FeedPost) => void): HTMLElement {
  const card = document.createElement('article');
  card.className = 'border-b border-ink/8';

  // Header
  const header = document.createElement('div');
  header.className = 'flex items-center gap-3 px-4 py-3';

  const avatar = document.createElement('img');
  avatar.src = post.account.avatarUrl;
  avatar.className = 'w-9 h-9 rounded-full object-cover bg-gold-light shrink-0';
  avatar.alt = '';
  header.appendChild(avatar);

  const info = document.createElement('div');
  info.className = 'flex-1 min-w-0';

  const nameEl = document.createElement('p');
  nameEl.className = 'text-sm font-medium text-ink truncate';
  nameEl.textContent = post.account.displayName;
  info.appendChild(nameEl);

  const metaEl = document.createElement('p');
  metaEl.className = 'text-xs text-ink/40';
  metaEl.textContent = `@${post.account.username} · ${formatRelativeTime(post.createdAt)}`;
  info.appendChild(metaEl);

  header.appendChild(info);
  card.appendChild(header);

  // Image wrapper
  const imgWrapper = document.createElement('div');
  imgWrapper.className = 'relative overflow-hidden cursor-pointer';

  const photo = document.createElement('img');
  photo.src = post.compositeUrl;
  photo.className = `w-full block ${unblurred ? '' : 'blur-2xl scale-110'}`;
  photo.alt = 'meenow photo';
  photo.loading = 'lazy';
  imgWrapper.appendChild(photo);

  if (!unblurred) {
    const overlay = document.createElement('div');
    overlay.className = 'absolute inset-0 flex items-center justify-center bg-black/10';
    const label = document.createElement('span');
    label.className = 'text-white text-sm font-medium drop-shadow-md bg-black/35 rounded-full px-4 py-2';
    label.textContent = 'Post yours to unblur';
    overlay.appendChild(label);
    imgWrapper.appendChild(overlay);
  } else {
    imgWrapper.addEventListener('click', () => onOpenPost(post));
  }

  card.appendChild(imgWrapper);

  if (post.statusText || post.location) {
    const meta = document.createElement('div');
    meta.className = 'px-4 pt-2 pb-1 flex flex-col gap-2';
    if (post.statusText) {
      const textEl = document.createElement('p');
      textEl.className = 'text-sm text-ink leading-relaxed whitespace-pre-line';
      textEl.textContent = post.statusText;
      meta.appendChild(textEl);
    }
    if (post.location) {
      const pill = document.createElement('span');
      pill.className = 'inline-block text-xs text-gold border border-gold/30 rounded-full px-3 py-1.5';
      pill.textContent = `📍 ${post.location}`;
      meta.appendChild(pill);
    }
    card.appendChild(meta);
  }

  if (post.replyCount > 0) {
    const cardFooter = document.createElement('div');
    cardFooter.className = 'flex items-center gap-1.5 px-4 py-2.5 text-xs text-ink/40';
    const iconEl = document.createElement('span');
    iconEl.className = 'w-3.5 h-3.5 shrink-0';
    iconEl.innerHTML = SPEECH_BUBBLE_ICON;
    cardFooter.appendChild(iconEl);
    const countEl = document.createElement('span');
    countEl.textContent = `${post.replyCount}`;
    cardFooter.appendChild(countEl);
    card.appendChild(cardFooter);
  }

  return card;
}
