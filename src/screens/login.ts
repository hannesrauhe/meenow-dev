// Login screen: OAuth PKCE entry point; prompts for a Pixelfed instance URL and initiates the auth flow.
import { startOAuthFlow } from '../api/auth';
import { isPwaInstalled } from '../state';

export function renderLogin(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'screen gap-8';
  el.id = 'screen-login';

  const installNudge = isPwaInstalled() ? '' : `
    <div class="w-full max-w-xs text-xs text-center leading-relaxed bg-gold/10 border border-gold/30 rounded-xl px-4 py-3 text-ink/70">
      <strong class="text-ink/90">Install the app first</strong> — add meenow to your home screen before connecting for the best experience and to receive notifications.
    </div>
  `;

  el.innerHTML = `
    <div class="text-center space-y-2">
      <h1 class="text-3xl font-semibold tracking-tight text-ink">meenow</h1>
      <p class="text-sm text-ink/50">A daily photo habit — one shot, once a day</p>
    </div>

    <div class="text-xs text-center max-w-xs leading-relaxed space-y-2 border border-ink/10 rounded-xl px-4 py-3">
      <p class="text-ink/70">You need a <strong>Pixelfed account</strong> to use meenow. We recommend setting up your account with <strong>followers-only</strong> visibility so only people you approve can see your photos.</p>
      <p class="text-ink/45">Mastodon accounts also work but are not recommended — follower management and archiving behave differently.</p>
    </div>

    ${installNudge}

    <form id="login-form" class="w-full max-w-xs space-y-4">
      <div class="space-y-1.5">
        <label class="text-xs text-ink/50 uppercase tracking-wider" for="instance-input">
          Your Pixelfed instance
        </label>
        <input
          id="instance-input"
          type="text"
          inputmode="url"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
          placeholder="pixelfed.de"
          class="w-full bg-cream border border-ink/15 rounded-xl px-4 py-3
                 text-ink placeholder:text-ink/30 text-base
                 focus:outline-none focus:border-gold transition-colors"
        />
      </div>
      <p id="login-error" class="text-xs text-red-500 hidden"></p>
      <button type="submit" id="login-submit" class="btn-primary w-full">Connect</button>
    </form>

    <div class="text-xs text-center max-w-xs leading-relaxed space-y-2 border border-ink/10 rounded-xl px-4 py-3">
      <p class="text-ink/60">Your followers on Pixelfed will see each photo you post. meenow uses <strong>followers-only</strong> visibility.</p>
      <p class="text-ink/50">On Pixelfed, photos are archived automatically after the next daily trigger — hidden from followers, but still visible to you.</p>
    </div>

    <p class="text-xs text-ink/25 text-center mt-4">
      Meenow is an experimental side project by
      <a href="https://rauhe.eu" target="_blank" rel="noopener noreferrer" class="underline underline-offset-2">Hannes Rauhe</a>
    </p>
  `;

  const form = el.querySelector('#login-form') as HTMLFormElement;
  const input = el.querySelector('#instance-input') as HTMLInputElement;
  const errorEl = el.querySelector('#login-error') as HTMLElement;
  const submitBtn = el.querySelector('#login-submit') as HTMLButtonElement;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const instance = input.value.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!instance) return;

    errorEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Connecting...';

    try {
      await startOAuthFlow(instance);
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : 'Connection failed.';
      errorEl.classList.remove('hidden');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Connect';
    }
  });

  return el;
}
