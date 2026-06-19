// Grid screen: archive of the authenticated user's own meenow photos in a 3-column grid grouped by month.
import { CHEVRON_LEFT_ICON } from '../icons';
import type { AuthState } from '../api/auth';
import { fetchMyAllPosts, type FeedPost } from '../api/pixelfed';

export function renderGrid(
  auth: AuthState,
  onOpenPost: (post: FeedPost) => void,
  onBack: () => void,
): HTMLElement {
  const root = document.createElement('div');
  root.id = 'screen-grid';
  root.className = 'min-h-dvh flex flex-col bg-cream';

  const header = document.createElement('header');
  header.className = 'sticky top-0 z-10 bg-cream/95 backdrop-blur-sm flex items-center gap-3 px-4 py-3 border-b border-ink/10';

  const backBtn = document.createElement('button');
  backBtn.className = 'flex items-center gap-1 text-sm text-gold font-medium w-8 h-8 -ml-1';
  backBtn.setAttribute('aria-label', 'Back to feed');
  backBtn.innerHTML = CHEVRON_LEFT_ICON;
  backBtn.addEventListener('click', onBack);
  header.appendChild(backBtn);

  const title = document.createElement('h1');
  title.className = 'text-base font-semibold text-ink';
  title.textContent = 'My Photos';
  header.appendChild(title);

  root.appendChild(header);

  const content = document.createElement('div');
  content.className = 'flex-1';
  root.appendChild(content);

  loadGridContent(content, auth, onOpenPost);
  return root;
}

async function loadGridContent(
  container: HTMLElement,
  auth: AuthState,
  onOpenPost: (post: FeedPost) => void,
): Promise<void> {
  container.innerHTML = `
    <div class="flex items-center justify-center py-20">
      <div class="w-8 h-8 border-[3px] border-gold/30 border-t-gold rounded-full animate-spin"></div>
    </div>
  `;

  let posts: FeedPost[];
  try {
    posts = await fetchMyAllPosts(auth);
  } catch {
    if (!container.isConnected) return;
    container.innerHTML = `
      <div class="flex flex-col items-center py-16 gap-3 text-center px-6">
        <p class="text-sm text-ink/50">Could not load photos.</p>
        <button id="btn-grid-retry" class="text-sm text-gold underline underline-offset-2">Retry</button>
      </div>
    `;
    container.querySelector('#btn-grid-retry')?.addEventListener('click', () => loadGridContent(container, auth, onOpenPost));
    return;
  }

  if (!container.isConnected) return;
  container.innerHTML = '';

  if (posts.length === 0) {
    container.innerHTML = `
      <div class="flex flex-col items-center py-16 gap-4 text-ink/40 text-center px-6">
        <p class="text-sm">No meenow photos yet.</p>
      </div>
    `;
    return;
  }

  const byMonth = groupByMonth(posts);
  for (const [monthKey, group] of byMonth) {
    const section = document.createElement('div');

    const heading = document.createElement('h2');
    heading.className = 'text-xs font-semibold text-ink/40 px-4 pt-4 pb-2 uppercase tracking-wider';
    heading.textContent = formatMonthYear(monthKey);
    section.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-3 gap-0.5';
    for (const post of group) {
      const cell = document.createElement('button');
      cell.className = 'aspect-square overflow-hidden bg-gold-light';
      cell.setAttribute('aria-label', `Photo from ${formatMonthYear(monthKey)}`);
      const img = document.createElement('img');
      img.src = post.compositeUrl;
      img.className = 'w-full h-full object-cover';
      img.alt = '';
      img.loading = 'lazy';
      cell.appendChild(img);
      cell.addEventListener('click', () => onOpenPost(post));
      grid.appendChild(cell);
    }
    section.appendChild(grid);
    container.appendChild(section);
  }
}

function groupByMonth(posts: FeedPost[]): Map<string, FeedPost[]> {
  const map = new Map<string, FeedPost[]>();
  for (const post of posts) {
    const key = `${post.createdAt.getFullYear()}-${String(post.createdAt.getMonth() + 1).padStart(2, '0')}`;
    const group = map.get(key);
    if (group) group.push(post);
    else map.set(key, [post]);
  }
  return map;
}

function formatMonthYear(key: string): string {
  const [year, month] = key.split('-');
  return new Date(Number(year), Number(month) - 1, 1)
    .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
