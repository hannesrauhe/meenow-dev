// Post detail screen: full-screen view of a single post with photo swiper, caption, location, comments, and reply input.
import { CHEVRON_LEFT_ICON, TRASH_ICON } from '../icons';
import type { AuthState } from '../api/auth';
import { fetchPostContext, postReply, type FeedPost, type MastodonReply } from '../api/pixelfed';
import { formatRelativeTime } from '../timer';

export function renderPostDetail(
  post: FeedPost,
  auth: AuthState,
  onBack: () => void,
  onDelete?: () => Promise<void>,
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
  title.className = 'flex-1 text-base font-semibold text-ink';
  title.textContent = 'Post';
  header.appendChild(title);

  if (onDelete && post.account.id === auth.accountId) {
    const trashBtn = document.createElement('button');
    trashBtn.className = 'w-8 h-8 flex items-center justify-center text-ink/40 hover:text-red-500 transition-colors';
    trashBtn.setAttribute('aria-label', 'Delete post');
    trashBtn.innerHTML = TRASH_ICON;
    trashBtn.addEventListener('click', () => showDeleteConfirm(root, onDelete));
    header.appendChild(trashBtn);
  }

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

  if (post.statusText || post.location) {
    const meta = document.createElement('div');
    meta.className = 'px-4 pt-3 pb-1 flex flex-col gap-2';
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
    scrollArea.appendChild(meta);
  }

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
  replyInput.className = 'flex-1 resize-none rounded-xl border border-ink/20 bg-cream px-3 py-2 text-sm text-ink placeholder:text-ink/35 focus:outline-none focus:border-gold/60 min-h-[40px] max-h-32';
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

function showDeleteConfirm(root: HTMLElement, onDelete: () => Promise<void>): void {
  const sheet = document.createElement('div');
  sheet.className = 'fixed inset-0 z-50 flex items-end bg-black/40';

  const panel = document.createElement('div');
  panel.className = 'w-full bg-cream rounded-t-2xl px-6 pt-6 pb-10 shadow-xl';

  const heading = document.createElement('p');
  heading.className = 'text-base font-semibold text-ink mb-1';
  heading.textContent = 'Delete this post?';
  panel.appendChild(heading);

  const sub = document.createElement('p');
  sub.className = 'text-sm text-ink/50 mb-6';
  sub.textContent = 'This cannot be undone.';
  panel.appendChild(sub);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'w-full py-3 rounded-xl bg-red-500 text-white font-semibold text-sm mb-3 transition-opacity';
  deleteBtn.textContent = 'Delete';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'w-full py-3 rounded-xl bg-ink/8 text-ink font-semibold text-sm';
  cancelBtn.textContent = 'Cancel';

  deleteBtn.addEventListener('click', () => {
    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Deleting…';
    cancelBtn.disabled = true;
    onDelete().catch(() => {
      deleteBtn.disabled = false;
      deleteBtn.textContent = 'Retry';
      cancelBtn.disabled = false;
    });
  });

  cancelBtn.addEventListener('click', () => { sheet.remove(); });
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });

  panel.appendChild(deleteBtn);
  panel.appendChild(cancelBtn);
  sheet.appendChild(panel);
  root.appendChild(sheet);
}

function makePhotoSwiper(post: FeedPost): HTMLElement {
  const urls = post.allMediaUrls;

  if (urls.length <= 1) {
    const img = document.createElement('img');
    img.src = post.compositeUrl;
    img.className = 'w-full block cursor-zoom-in';
    img.alt = 'meenow photo';
    img.addEventListener('click', () => openLightbox([post.compositeUrl], 0));
    return img;
  }

  // Preload all images so swipe transitions are instant
  urls.forEach(url => { const i = new Image(); i.src = url; });

  const photoLabels = ['composite', 'surroundings', 'selfie'];
  let currentIndex = 0;

  const wrapper = document.createElement('div');
  wrapper.className = 'relative overflow-hidden bg-black select-none cursor-zoom-in';

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

  wrapper.addEventListener('click', () => openLightbox(urls, currentIndex));

  return wrapper;
}

function openLightbox(urls: string[], startIndex: number): void {
  urls.forEach(url => { const i = new Image(); i.src = url; });

  let idx = startIndex;
  let scale = 1;
  let panX = 0;
  let panY = 0;

  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-[100] bg-black flex items-center justify-center';
  overlay.style.touchAction = 'none';

  const img = document.createElement('img');
  img.className = 'max-w-full max-h-dvh object-contain select-none';
  img.style.willChange = 'transform';
  img.draggable = false;
  img.alt = '';
  img.src = urls[idx];
  overlay.appendChild(img);

  const applyTransform = (): void => {
    img.style.transform = scale === 1
      ? ''
      : `scale(${scale}) translate(${panX / scale}px, ${panY / scale}px)`;
  };

  const dotClass = (active: boolean): string =>
    `w-1.5 h-1.5 rounded-full ${active ? 'bg-white' : 'bg-white/40'}`;
  const dots: HTMLElement[] = [];

  const setImage = (i: number): void => {
    idx = i;
    img.src = urls[i];
    scale = 1; panX = 0; panY = 0;
    img.style.transform = '';
    dots.forEach((d, j) => { d.className = dotClass(j === i); });
  };

  const close = (): void => { overlay.remove(); };

  const closeBtn = document.createElement('button');
  closeBtn.className = 'absolute top-4 right-4 z-10 w-10 h-10 flex items-center justify-center rounded-full bg-black/50 text-white text-2xl leading-none';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', close);
  overlay.appendChild(closeBtn);

  if (urls.length > 1) {
    const dotsBar = document.createElement('div');
    dotsBar.className = 'absolute bottom-4 left-0 right-0 flex justify-center gap-1.5 pointer-events-none';
    urls.forEach((_, i) => {
      const dot = document.createElement('div');
      dot.className = dotClass(i === idx);
      dotsBar.appendChild(dot);
      dots.push(dot);
    });
    overlay.appendChild(dotsBar);
  }

  // Touch handling — single touch: tap=close, drag=pan (when zoomed), swipe=navigate (when not zoomed)
  //                  two touches: pinch to zoom
  let startTouchX = 0;
  let startTouchY = 0;
  let startPanX = 0;
  let startPanY = 0;
  let startScale = 1;
  let initialPinchDist = 0;
  let pinchActive = false;
  let axis: 'h' | 'v' | null = null;
  let isTap = true;

  overlay.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (e.touches.length === 2) {
      pinchActive = true;
      isTap = false;
      startScale = scale;
      startPanX = panX;
      startPanY = panY;
      initialPinchDist = Math.hypot(
        e.touches[1].clientX - e.touches[0].clientX,
        e.touches[1].clientY - e.touches[0].clientY,
      );
    } else if (e.touches.length === 1) {
      pinchActive = false;
      startTouchX = e.touches[0].clientX;
      startTouchY = e.touches[0].clientY;
      startPanX = panX;
      startPanY = panY;
      axis = null;
      isTap = true;
    }
  }, { passive: false });

  overlay.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (pinchActive && e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[1].clientX - e.touches[0].clientX,
        e.touches[1].clientY - e.touches[0].clientY,
      );
      scale = Math.min(5, Math.max(1, startScale * dist / initialPinchDist));
      applyTransform();
    } else if (!pinchActive && e.touches.length === 1) {
      const dx = e.touches[0].clientX - startTouchX;
      const dy = e.touches[0].clientY - startTouchY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) isTap = false;
      if (scale > 1) {
        panX = startPanX + dx;
        panY = startPanY + dy;
        applyTransform();
      } else if (axis === null && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        axis = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
      }
    }
  }, { passive: false });

  overlay.addEventListener('touchend', (e) => {
    if (isTap) { close(); return; }
    if (scale <= 1) { scale = 1; panX = 0; panY = 0; img.style.transform = ''; }
    if (!pinchActive && scale <= 1 && axis === 'h' && e.changedTouches.length > 0) {
      const dx = e.changedTouches[0].clientX - startTouchX;
      if (Math.abs(dx) >= 40) {
        const newIdx = dx < 0 ? idx + 1 : idx - 1;
        if (newIdx >= 0 && newIdx < urls.length) setImage(newIdx);
      }
    }
    if (e.touches.length < 2) pinchActive = false;
  }, { passive: true });

  // Keyboard: Escape closes, arrow keys navigate
  const handleKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft' && idx > 0) setImage(idx - 1);
    else if (e.key === 'ArrowRight' && idx < urls.length - 1) setImage(idx + 1);
  };
  document.addEventListener('keydown', handleKey);

  const observer = new MutationObserver(() => {
    if (!overlay.isConnected) { document.removeEventListener('keydown', handleKey); observer.disconnect(); }
  });
  observer.observe(document.body, { childList: true });

  document.body.appendChild(overlay);
}

async function loadComments(section: HTMLElement, auth: AuthState, statusId: string): Promise<void> {
  section.innerHTML = `
    <div class="flex items-center justify-center py-8">
      <div class="w-6 h-6 spinner"></div>
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
  // Trusted: server-sanitized HTML from the Mastodon/Pixelfed API.
  content.innerHTML = reply.content;
  body.appendChild(content);

  row.appendChild(body);
  return row;
}
