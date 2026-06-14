import { SLEEPING_CAT } from '../icons';
import { clearAuth } from '../api/auth';
import { getAuthState } from '../api/auth';
import { postsToday, MAX_POSTS_PER_TRIGGER } from '../state';
import { fetchMeenowFeed, type FeedPost } from '../api/pixelfed';
import { renderCapture } from './capture';

export function renderFeed(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'min-h-dvh flex flex-col bg-cream';
  el.id = 'screen-feed';

  const header = document.createElement('header');
  header.className = 'sticky top-0 z-10 bg-cream/95 backdrop-blur-sm flex items-center justify-between px-5 py-4 border-b border-ink/10';
  const count = postsToday();
  header.innerHTML = `
    <h1 class="text-xl font-semibold tracking-tight text-ink">meenow</h1>
    <div class="flex items-center gap-3">
      ${count < MAX_POSTS_PER_TRIGGER
        ? `<button id="btn-post-again" class="text-sm font-semibold text-gold">+ Post</button>`
        : ''}
      <span class="text-xs text-ink/40">${count}/${MAX_POSTS_PER_TRIGGER} posted</span>
      <button id="btn-logout" class="text-xs text-ink/35 hover:text-ink/60 transition-colors">disconnect</button>
    </div>
  `;
  el.appendChild(header);

  const content = document.createElement('div');
  content.id = 'feed-content';
  el.appendChild(content);

  const footer = document.createElement('footer');
  footer.className = 'py-6 text-center text-xs text-ink/25';
  footer.innerHTML = `Meenow is an experimental side project by <a href="https://rauhe.eu" target="_blank" rel="noopener noreferrer" class="underline underline-offset-2">Hannes Rauhe</a>`;
  el.appendChild(footer);

  header.querySelector('#btn-post-again')?.addEventListener('click', () => {
    const appEl = document.getElementById('app');
    if (appEl) { appEl.innerHTML = ''; appEl.appendChild(renderCapture()); }
  });

  header.querySelector('#btn-logout')?.addEventListener('click', () => {
    clearAuth();
    window.location.reload();
  });

  loadFeed(content);
  return el;
}

function formatRelativeTime(d: Date): string {
  const ms = Date.now() - d.getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

async function loadFeed(container: HTMLElement): Promise<void> {
  const auth = getAuthState();
  if (!auth) return;

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
    container.querySelector('#btn-feed-retry')?.addEventListener('click', () => loadFeed(container));
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

  const unblurred = postsToday() > 0;
  posts.forEach(post => container.appendChild(makePostCard(post, unblurred)));
}

function makePostCard(post: FeedPost, unblurred: boolean): HTMLElement {
  const card = document.createElement('article');
  card.className = 'border-b border-ink/8';

  card.innerHTML = `
    <div class="flex items-center gap-3 px-4 py-3">
      <img
        src="${post.account.avatarUrl}"
        class="w-9 h-9 rounded-full object-cover bg-gold-light shrink-0"
        alt=""
      />
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium text-ink truncate">${post.account.displayName}</p>
        <p class="text-xs text-ink/40">@${post.account.username} · ${formatRelativeTime(post.createdAt)}</p>
      </div>
    </div>
    <div class="relative overflow-hidden cursor-pointer" id="post-img-${post.id}">
      <img
        src="${post.compositeUrl}"
        class="w-full block ${unblurred ? '' : 'blur-2xl scale-110'}"
        alt="meenow photo"
        loading="lazy"
      />
      ${!unblurred ? `
        <div class="absolute inset-0 flex items-center justify-center bg-black/10">
          <span class="text-white text-sm font-medium drop-shadow-md bg-black/35 rounded-full px-4 py-2">
            Post yours to unblur
          </span>
        </div>
      ` : post.allMediaUrls.length > 1 ? `
        <a href="${post.url}" target="_blank" rel="noopener noreferrer"
           class="absolute top-3 right-3 bg-black/40 text-white text-xs px-2.5 py-1 rounded-full backdrop-blur-sm">
          ${post.allMediaUrls.length} photos
        </a>
      ` : ''}
    </div>
  `;

  if (unblurred) {
    card.querySelector(`#post-img-${post.id}`)?.addEventListener('click', () => {
      window.open(post.url, '_blank', 'noopener,noreferrer');
    });
  }

  return card;
}
