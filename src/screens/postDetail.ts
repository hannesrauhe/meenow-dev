import { CHEVRON_LEFT_ICON } from '../icons';
import type { AuthState } from '../api/auth';
import { fetchPostContext, postReply, type FeedPost, type MastodonReply } from '../api/pixelfed';
import { formatRelativeTime } from '../timer';

export function renderPostDetail(
  post: FeedPost,
  auth: AuthState,
  onBack: () => void,
): HTMLElement {
  const root = document.createElement('div');
  root.id = 'screen-post-detail';
  root.className = 'min-h-dvh flex flex-col bg-cream';

  // Header
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
  title.textContent = 'Post';
  header.appendChild(title);

  root.appendChild(header);

  // Scrollable content
  const scrollArea = document.createElement('div');
  scrollArea.className = 'flex-1 overflow-y-auto';

  // Author row
  const authorRow = document.createElement('div');
  authorRow.className = 'flex items-center gap-3 px-4 py-3';

  const avatar = document.createElement('img');
  avatar.src = post.account.avatarUrl;
  avatar.className = 'w-9 h-9 rounded-full object-cover bg-gold-light shrink-0';
  avatar.alt = '';
  authorRow.appendChild(avatar);

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

  authorRow.appendChild(info);
  scrollArea.appendChild(authorRow);

  scrollArea.appendChild(makePhotoSwiper(post));

  // Comments section
  const commentsSection = document.createElement('div');
  commentsSection.id = 'comments-section';
  commentsSection.className = 'px-4 py-2';
  scrollArea.appendChild(commentsSection);

  root.appendChild(scrollArea);

  // Reply bar
  const replyBar = document.createElement('div');
  replyBar.className = 'sticky bottom-0 bg-cream border-t border-ink/10 px-4 py-3 flex gap-2';

  const replyInput = document.createElement('textarea');
  replyInput.id = 'reply-input';
  replyInput.className = 'flex-1 resize-none rounded-xl border border-ink/20 bg-white px-3 py-2 text-sm text-ink placeholder:text-ink/35 focus:outline-none focus:border-gold/60 min-h-[40px] max-h-32';
  replyInput.placeholder = 'Add a reply…';
  replyInput.rows = 1;
  replyBar.appendChild(replyInput);

  const sendBtn = document.createElement('button');
  sendBtn.id = 'btn-send';
  sendBtn.className = 'self-end px-4 py-2 rounded-xl bg-gold text-white text-sm font-semibold disabled:opacity-40 transition-opacity';
  sendBtn.textContent = 'Send';
  sendBtn.disabled = true;
  replyBar.appendChild(sendBtn);

  replyInput.addEventListener('input', () => {
    sendBtn.disabled = replyInput.value.trim() === '';
  });

  sendBtn.addEventListener('click', () => {
    const text = replyInput.value.trim();
    if (!text) return;
    replyInput.disabled = true;
    sendBtn.disabled = true;
    sendBtn.textContent = '…';
    postReply(auth, post.id, text)
      .then(() => {
        replyInput.value = '';
        replyInput.disabled = false;
        sendBtn.textContent = 'Send';
        sendBtn.disabled = true;
        loadComments(commentsSection, auth, post.id);
      })
      .catch(() => {
        replyInput.disabled = false;
        sendBtn.disabled = false;
        sendBtn.textContent = 'Retry';
      });
  });

  root.appendChild(replyBar);

  loadComments(commentsSection, auth, post.id);

  return root;
}

function makePhotoSwiper(post: FeedPost): HTMLElement {
  const urls = post.allMediaUrls;

  if (urls.length <= 1) {
    const img = document.createElement('img');
    img.src = post.compositeUrl;
    img.className = 'w-full block';
    img.alt = 'meenow photo';
    return img;
  }

  // Preload all images so swipe transitions are instant
  urls.forEach(url => { const i = new Image(); i.src = url; });

  const photoLabels = ['composite', 'surroundings', 'selfie'];
  let currentIndex = 0;

  const wrapper = document.createElement('div');
  wrapper.className = 'relative overflow-hidden bg-black select-none';

  const photo = document.createElement('img');
  photo.src = urls[0];
  photo.className = 'w-full block';
  photo.style.transition = 'opacity 0.15s ease';
  photo.alt = 'meenow photo';
  wrapper.appendChild(photo);

  // Label (top-left corner)
  const labelEl = document.createElement('div');
  labelEl.className = 'absolute top-3 left-3 bg-black/40 text-white text-xs px-2.5 py-1 rounded-full backdrop-blur-sm pointer-events-none';
  labelEl.textContent = photoLabels[0];
  wrapper.appendChild(labelEl);

  // Dot indicators (bottom center)
  const dotsBar = document.createElement('div');
  dotsBar.className = 'absolute bottom-3 left-0 right-0 flex justify-center gap-1.5 pointer-events-none';
  const dots = urls.map((_, i) => {
    const dot = document.createElement('div');
    dot.className = `w-1.5 h-1.5 rounded-full ${i === 0 ? 'bg-white' : 'bg-white/40'}`;
    dotsBar.appendChild(dot);
    return dot;
  });
  wrapper.appendChild(dotsBar);

  const goTo = (index: number): void => {
    if (index === currentIndex || index < 0 || index >= urls.length) return;
    photo.style.opacity = '0';
    setTimeout(() => {
      currentIndex = index;
      photo.src = urls[currentIndex];
      photo.style.opacity = '1';
      dots.forEach((d, i) => {
        d.className = `w-1.5 h-1.5 rounded-full ${i === currentIndex ? 'bg-white' : 'bg-white/40'}`;
      });
      labelEl.textContent = photoLabels[currentIndex] ?? '';
    }, 150);
  };

  // Touch swipe — lock axis after first significant movement so vertical scroll
  // still works when the user is not doing a horizontal swipe.
  let startX = 0;
  let startY = 0;
  let axis: 'h' | 'v' | null = null;

  wrapper.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    axis = null;
  }, { passive: true });

  wrapper.addEventListener('touchmove', (e) => {
    if (axis === 'v') return;
    const dx = Math.abs(e.touches[0].clientX - startX);
    const dy = Math.abs(e.touches[0].clientY - startY);
    if (axis === null && (dx > 5 || dy > 5)) {
      axis = dx >= dy ? 'h' : 'v';
    }
    if (axis === 'h') e.preventDefault();
  }, { passive: false });

  wrapper.addEventListener('touchend', (e) => {
    if (axis !== 'h') return;
    const deltaX = e.changedTouches[0].clientX - startX;
    if (Math.abs(deltaX) >= 40) {
      goTo(deltaX < 0 ? currentIndex + 1 : currentIndex - 1);
    }
  }, { passive: true });

  return wrapper;
}

async function loadComments(section: HTMLElement, auth: AuthState, statusId: string): Promise<void> {
  section.innerHTML = `
    <div class="flex items-center justify-center py-8">
      <div class="w-6 h-6 border-[3px] border-gold/30 border-t-gold rounded-full animate-spin"></div>
    </div>
  `;

  let context;
  try {
    context = await fetchPostContext(auth, statusId);
  } catch {
    if (!section.isConnected) return;
    section.innerHTML = `<p class="text-sm text-ink/50 text-center py-8">Could not load replies.</p>`;
    return;
  }

  if (!section.isConnected) return;
  section.innerHTML = '';

  if (context.descendants.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'text-sm text-ink/40 text-center py-8';
    empty.textContent = 'No replies yet.';
    section.appendChild(empty);
    return;
  }

  context.descendants.forEach(reply => section.appendChild(makeReplyRow(reply)));
}

function makeReplyRow(reply: MastodonReply): HTMLElement {
  const row = document.createElement('div');
  row.className = 'flex gap-3 py-3 border-b border-ink/8';

  const avatar = document.createElement('img');
  avatar.src = reply.account.avatar;
  avatar.className = 'w-8 h-8 rounded-full object-cover bg-gold-light shrink-0 mt-0.5';
  avatar.alt = '';
  row.appendChild(avatar);

  const body = document.createElement('div');
  body.className = 'flex-1 min-w-0';

  const meta = document.createElement('p');
  meta.className = 'text-xs text-ink/40 mb-1';
  meta.textContent = `@${reply.account.username} · ${formatRelativeTime(new Date(reply.created_at))}`;
  body.appendChild(meta);

  const content = document.createElement('div');
  content.className = 'text-sm text-ink';
  content.innerHTML = reply.content;
  body.appendChild(content);

  row.appendChild(body);
  return row;
}
