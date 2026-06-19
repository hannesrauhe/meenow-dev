// Login screen: OAuth PKCE entry point; prompts for a Pixelfed instance URL and initiates the auth flow.
import { startOAuthFlow } from '../api/auth';

export function renderLogin(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'screen gap-8';
  el.id = 'screen-login';

  el.innerHTML = `
    <div class="text-center space-y-2">
      <h1 class="text-3xl font-semibold tracking-tight text-ink">meenow</h1>
      <p class="text-sm text-ink/50">Connect your Pixelfed account to get started</p>
    </div>

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
          placeholder="pixelfed.social"
          class="w-full bg-white border border-ink/15 rounded-xl px-4 py-3
                 text-ink placeholder:text-ink/30 text-base
                 focus:outline-none focus:border-gold transition-colors"
        />
      </div>
      <p id="login-error" class="text-xs text-red-500 hidden"></p>
      <button type="submit" id="login-submit" class="btn-primary w-full">Connect</button>
    </form>

    <p class="text-xs text-ink/30 text-center max-w-xs leading-relaxed">
      meenow posts to your account with followers-only visibility.<br/>
      Your credentials are never stored by this app.
    </p>

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
