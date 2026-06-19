import { CHEVRON_LEFT_ICON } from '../icons';
import type { AuthState } from '../api/auth';
import { fetchMyMeenowPage, type FeedPost } from '../api/pixelfed';

// Session-level cache of the authenticated user's own meenow posts.
// undefined cursor = not yet fetched; null = exhausted; string = next page cursor.
let _myPosts: FeedPost[] = [];
let _cursor: string | null | undefined = undefined;
let _pending: Promise<void> | null = null;

async function fetchNextPage(auth: AuthState): Promise<void> {
  if (_cursor === null) return;
  const maxId = _cursor === undefined ? undefined : _cursor;
  const { posts, cursor } = await fetchMyMeenowPage(auth, maxId);
  _myPosts = [..._myPosts, ...posts];
  _cursor = cursor;
}

async function ensureLoadedUpTo(auth: AuthState, targetDate: Date): Promise<void> {
  while (
    _cursor !== null &&
    (_myPosts.length === 0 || _myPosts[_myPosts.length - 1].createdAt >= targetDate)
  ) {
    if (!_pending) {
      _pending = fetchNextPage(auth).finally(() => { _pending = null; });
    }
    await _pending;
  }
}

function monthLabel(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
}

function postsForMonth(year: number, month: number): FeedPost[] {
  return _myPosts.filter(p => p.createdAt.getFullYear() === year && p.createdAt.getMonth() === month);
}

export function renderArchive(
  auth: AuthState,
  onOpenPost: (post: FeedPost) => void,
  onBack: () => void,
): HTMLElement {
  const now = new Date();
  let currentYear = now.getFullYear();
  let currentMonth = now.getMonth();

  const el = document.createElement('div');
  el.className = 'min-h-dvh flex flex-col bg-cream';

  // Header
  const header = document.createElement('header');
  header.className = 'sticky top-0 z-10 bg-cream/95 backdrop-blur-sm flex items-center gap-3 px-4 py-4 border-b border-ink/10';
  const backBtn = document.createElement('button');
  backBtn.className = 'w-6 h-6 text-ink/60 shrink-0';
  backBtn.innerHTML = CHEVRON_LEFT_ICON;
  backBtn.addEventListener('click', onBack);
  const title = document.createElement('h1');
  title.className = 'text-xl font-semibold tracking-tight text-ink';
  title.textContent = 'My Meenow';
  header.appendChild(backBtn);
  header.appendChild(title);
  el.appendChild(header);

  // Month navigation bar
  const navBar = document.createElement('div');
  navBar.className = 'flex items-center justify-between px-5 py-3 border-b border-ink/10';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'w-8 h-8 flex items-center justify-center text-ink/60 disabled:opacity-25 transition-opacity';
  prevBtn.innerHTML = CHEVRON_LEFT_ICON;

  const monthLabel_el = document.createElement('span');
  monthLabel_el.className = 'text-sm font-medium text-ink';

  const nextBtn = document.createElement('button');
  nextBtn.className = 'w-8 h-8 flex items-center justify-center text-ink/60 disabled:opacity-25 transition-opacity rotate-180';
  nextBtn.innerHTML = CHEVRON_LEFT_ICON;

  navBar.appendChild(prevBtn);
  navBar.appendChild(monthLabel_el);
  navBar.appendChild(nextBtn);
  el.appendChild(navBar);

  // Content area (grid or states)
  const content = document.createElement('div');
  content.className = 'flex-1';
  el.appendChild(content);

  function updateNavButtons(): void {
    const todayYear = new Date().getFullYear();
    const todayMonth = new Date().getMonth();
    const isCurrentMonth = currentYear === todayYear && currentMonth === todayMonth;
    nextBtn.disabled = isCurrentMonth;

    const firstDayOfMonth = new Date(currentYear, currentMonth, 1);
    const canGoBack = _cursor !== null || _myPosts.some(p => p.createdAt < firstDayOfMonth);
    prevBtn.disabled = !canGoBack;
  }

  async function renderMonth(): Promise<void> {
    monthLabel_el.textContent = monthLabel(currentYear, currentMonth);
    content.innerHTML = `
      <div class="flex items-center justify-center py-20">
        <div class="w-8 h-8 border-[3px] border-gold/30 border-t-gold rounded-full animate-spin"></div>
      </div>
    `;
    updateNavButtons();

    const firstDayOfMonth = new Date(currentYear, currentMonth, 1);
    try {
      await ensureLoadedUpTo(auth, firstDayOfMonth);
    } catch {
      content.innerHTML = `
        <div class="flex flex-col items-center py-16 gap-3 text-center px-6">
          <p class="text-sm text-ink/50">Could not load posts.</p>
          <button id="btn-archive-retry" class="text-sm text-gold underline underline-offset-2">Retry</button>
        </div>
      `;
      content.querySelector('#btn-archive-retry')?.addEventListener('click', () => void renderMonth());
      return;
    }

    updateNavButtons();
    const posts = postsForMonth(currentYear, currentMonth);
    content.innerHTML = '';

    if (posts.length === 0) {
      content.innerHTML = `
        <div class="flex items-center justify-center py-20 px-6">
          <p class="text-sm text-ink/40 text-center">No meenow posts in this month.</p>
        </div>
      `;
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-3 gap-0.5 p-0.5';
    posts.forEach(post => {
      const cell = document.createElement('button');
      cell.className = 'aspect-square overflow-hidden bg-ink/5';
      const img = document.createElement('img');
      img.src = post.compositeUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.className = 'w-full h-full object-cover';
      cell.appendChild(img);
      cell.addEventListener('click', () => onOpenPost(post));
      grid.appendChild(cell);
    });
    content.appendChild(grid);
  }

  prevBtn.addEventListener('click', () => {
    currentMonth -= 1;
    if (currentMonth < 0) { currentMonth = 11; currentYear -= 1; }
    void renderMonth();
  });

  nextBtn.addEventListener('click', () => {
    currentMonth += 1;
    if (currentMonth > 11) { currentMonth = 0; currentYear += 1; }
    void renderMonth();
  });

  void renderMonth();
  return el;
}
