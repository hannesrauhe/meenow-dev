// Login screen: a short onboarding wizard that introduces meenow and Pixelfed,
// then collects an instance URL and initiates the OAuth PKCE flow on the final step.
import { startOAuthFlow } from '../api/auth';
import { isPwaInstalled } from '../state';

const STEP_COUNT = 4;

export function renderLogin(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'screen';
  el.id = 'screen-login';

  // Wizard state kept local to this element; main.ts routing is untouched.
  let step = 0;
  let instanceValue = '';

  const goTo = (n: number) => {
    step = Math.max(0, Math.min(STEP_COUNT - 1, n));
    render();
  };

  const dots = () =>
    Array.from({ length: STEP_COUNT }, (_, i) =>
      `<span class="h-1.5 rounded-full transition-all ${
        i === step ? 'w-5 bg-gold' : 'w-1.5 bg-ink/20'
      }"></span>`,
    ).join('');

  // Each intro step: a title, body HTML, and the label for the forward button.
  const introSteps: { title: string; body: string; next: string }[] = [
    {
      title: `<h1 class="text-3xl font-semibold tracking-tight text-ink">meenow</h1>
              <p class="text-sm text-ink/50 mt-1">A daily photo habit — one shot, once a day</p>`,
      body: `<p class="text-ink/70">Once a day, at an unpredictable moment, meenow asks you to
              capture what you are doing — front and back camera in a single frame.</p>
             <p class="text-ink/50">No feed to scroll and no likes to chase. Just a shared daily
              glimpse among the people you choose.</p>`,
      next: 'Get started',
    },
    {
      title: `<h2 class="text-2xl font-semibold text-ink">Built on Pixelfed</h2>`,
      body: `<p class="text-ink/70">meenow has no server of its own. Your photos are stored on
              <strong>Pixelfed</strong>, an open photo-sharing network.</p>
             <p class="text-ink/50">Pixelfed is <strong>federated</strong>, much like email: no single
              company owns it. Many independent servers — called <em>instances</em> — run the same
              software and talk to each other. You keep your account on one instance and can still
              follow people on any other.</p>`,
      next: 'Next',
    },
    {
      title: `<h2 class="text-2xl font-semibold text-ink">You stay in control</h2>`,
      body: `<p class="text-ink/70">Unlike traditional social apps, there is no central owner, no
              advertising, and no algorithm deciding what you see.</p>
             <p class="text-ink/50">meenow posts are <strong>followers-only</strong> — visible to the
              people you approve, and no one else. Older photos are archived automatically after the
              next daily prompt: hidden from others, but always visible to you.</p>`,
      next: 'Next',
    },
  ];

  function render() {
    el.innerHTML = '';

    if (step < introSteps.length) {
      renderIntroStep(introSteps[step]);
    } else {
      renderConnectStep();
    }
  }

  function skipLink(): string {
    // Lets a returning user jump straight to the instance form.
    return step < STEP_COUNT - 1
      ? `<button id="skip" class="absolute top-0 right-0 text-xs text-ink/40 underline underline-offset-2 px-1 py-1">Skip</button>`
      : '';
  }

  function renderIntroStep(s: { title: string; body: string; next: string }) {
    const wrap = document.createElement('div');
    wrap.className = 'relative w-full max-w-xs flex flex-col items-center gap-8 text-center';
    wrap.innerHTML = `
      ${skipLink()}
      <div class="space-y-2 pt-6">${s.title}</div>
      <div class="text-sm leading-relaxed space-y-3">${s.body}</div>

      <div class="w-full space-y-4 pt-2">
        <div class="flex items-center justify-center gap-1.5">${dots()}</div>
        <button id="next" class="btn-primary w-full">${s.next}</button>
        ${step > 0 ? `<button id="back" class="text-sm text-ink/45 underline underline-offset-2">Back</button>` : ''}
      </div>

      ${step === 0
        ? `<p class="text-xs text-ink/25 leading-relaxed pt-2">
             An experimental side project by
             <a href="https://rauhe.eu" target="_blank" rel="noopener noreferrer" class="underline underline-offset-2">Hannes Rauhe</a>
           </p>`
        : ''}
    `;
    el.appendChild(wrap);

    wrap.querySelector('#next')?.addEventListener('click', () => goTo(step + 1));
    wrap.querySelector('#back')?.addEventListener('click', () => goTo(step - 1));
    wrap.querySelector('#skip')?.addEventListener('click', () => goTo(STEP_COUNT - 1));
  }

  function renderConnectStep() {
    const installReminder = isPwaInstalled()
      ? ''
      : `<p class="text-xs text-center leading-relaxed bg-gold/10 border border-gold/30 rounded-xl px-4 py-2.5 text-ink/70">
           For notifications and the best experience, add meenow to your home screen first.
         </p>`;

    const wrap = document.createElement('div');
    wrap.className = 'w-full max-w-xs flex flex-col gap-6';
    wrap.innerHTML = `
      <div class="text-center space-y-2">
        <h2 class="text-2xl font-semibold text-ink">Choose your instance</h2>
        <p class="text-sm text-ink/60 leading-relaxed">
          You need a Pixelfed account to continue. If you do not have one yet, create it on any
          instance first, then come back.
        </p>
        <a href="https://pixelfed.org" target="_blank" rel="noopener noreferrer"
           class="inline-block text-xs text-gold underline underline-offset-2">Find a Pixelfed instance →</a>
      </div>

      ${installReminder}

      <form id="login-form" class="w-full space-y-4">
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

      <p class="text-xs text-ink/40 text-center leading-relaxed">
        Mastodon accounts also work but are not recommended — follower management and archiving
        behave differently.
      </p>

      <div class="flex items-center justify-center gap-1.5">${dots()}</div>
      <button id="back" class="text-sm text-ink/45 underline underline-offset-2 text-center">Back</button>
    `;
    el.appendChild(wrap);

    const form = wrap.querySelector('#login-form') as HTMLFormElement;
    const input = wrap.querySelector('#instance-input') as HTMLInputElement;
    const errorEl = wrap.querySelector('#login-error') as HTMLElement;
    const submitBtn = wrap.querySelector('#login-submit') as HTMLButtonElement;

    input.value = instanceValue;
    input.addEventListener('input', () => {
      instanceValue = input.value;
    });

    wrap.querySelector('#back')?.addEventListener('click', () => goTo(step - 1));

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
  }

  render();
  return el;
}
