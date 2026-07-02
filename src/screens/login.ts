// Login screen: a short onboarding wizard that introduces meenow and Pixelfed,
// recommends installing the PWA, then collects an instance and starts OAuth PKCE.
import { startOAuthFlow } from '../api/auth';
import { isPwaInstalled } from '../state';
import { isIOS, canPromptInstall, promptInstall } from '../components/installNudge';

interface IntroStep {
  title: string;
  body: string;
  next: string;
}

type Step =
  | { kind: 'intro'; data: IntroStep }
  | { kind: 'install' }
  | { kind: 'connect' };

// One-tap instance suggestions (see plan / issue #58 discussion). pixelfed.org
// is the project homepage, not a sign-up instance, so it stays an info link.
const SUGGESTED_INSTANCES = ['pixelfed.de', 'pixelfed.social'];

const INTRO_STEPS: IntroStep[] = [
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

export function renderLogin(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'screen';
  el.id = 'screen-login';

  // The install step is skipped when meenow already runs as an installed PWA,
  // so the step count (and progress dots) adapt to the actual flow length.
  const steps: Step[] = [
    ...INTRO_STEPS.map((data): Step => ({ kind: 'intro', data })),
    ...(isPwaInstalled() ? [] : [{ kind: 'install' } as Step]),
    { kind: 'connect' },
  ];
  const lastIndex = steps.length - 1;

  let step = 0;
  let instanceValue = '';

  const goTo = (n: number) => {
    step = Math.max(0, Math.min(lastIndex, n));
    render();
  };

  const dots = () =>
    steps
      .map((_, i) =>
        `<span class="h-1.5 rounded-full transition-all ${
          i === step ? 'w-5 bg-gold' : 'w-1.5 bg-ink/20'
        }"></span>`,
      )
      .join('');

  const skipLink = () =>
    step < lastIndex
      ? `<button id="skip" class="absolute top-0 right-0 text-xs text-ink/40 underline underline-offset-2 px-1 py-1">Skip</button>`
      : '';

  function render() {
    el.innerHTML = '';
    const s = steps[step];
    if (s.kind === 'intro') renderIntroStep(s.data);
    else if (s.kind === 'install') renderInstallStep();
    else renderConnectStep();
  }

  function renderIntroStep(s: IntroStep) {
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
    wrap.querySelector('#skip')?.addEventListener('click', () => goTo(lastIndex));
  }

  function renderInstallStep() {
    const canPrompt = !isIOS() && canPromptInstall();
    let instructions: string;
    if (isIOS()) {
      instructions = 'Tap <strong>Share ↑</strong> in your browser, then <strong>Add to Home Screen</strong>.';
    } else if (canPrompt) {
      instructions = 'Install meenow for one-tap access and daily reminders.';
    } else {
      instructions = 'Open your browser menu and tap <strong>Add to Home Screen</strong>.';
    }

    const wrap = document.createElement('div');
    wrap.className = 'relative w-full max-w-xs flex flex-col items-center gap-8 text-center';
    wrap.innerHTML = `
      ${skipLink()}
      <div class="space-y-2 pt-6">
        <h2 class="text-2xl font-semibold text-ink">Install meenow</h2>
      </div>
      <div class="text-sm leading-relaxed space-y-3">
        <p class="text-ink/70">Add meenow to your home screen for an app-like experience and reliable
          daily reminders.</p>
        <p class="text-ink/50">Installing before you connect also makes sure notifications reach the
          app rather than your browser.</p>
        <p class="text-ink/50">${instructions}</p>
      </div>

      <div class="w-full space-y-4 pt-2">
        <div class="flex items-center justify-center gap-1.5">${dots()}</div>
        ${canPrompt ? `<button id="install" class="btn-primary w-full">Install</button>` : ''}
        <button id="continue" class="${canPrompt ? 'text-sm text-ink/45 underline underline-offset-2' : 'btn-primary w-full'}">Continue in browser</button>
        <button id="back" class="text-sm text-ink/45 underline underline-offset-2">Back</button>
      </div>
    `;
    el.appendChild(wrap);

    wrap.querySelector('#install')?.addEventListener('click', () => void promptInstall());
    wrap.querySelector('#continue')?.addEventListener('click', () => goTo(step + 1));
    wrap.querySelector('#back')?.addEventListener('click', () => goTo(step - 1));
    wrap.querySelector('#skip')?.addEventListener('click', () => goTo(lastIndex));
  }

  function renderConnectStep() {
    const wrap = document.createElement('div');
    wrap.className = 'w-full max-w-xs flex flex-col gap-5';
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

      <div class="w-full space-y-2.5">
        ${SUGGESTED_INSTANCES.map(
          (name) => `
          <button data-instance="${name}" class="instance-pick w-full flex items-center justify-between
                   bg-cream border border-ink/15 rounded-xl px-4 py-3 text-left
                   active:scale-[.99] transition-transform hover:border-gold">
            <span class="font-medium text-ink">${name}</span>
            <span class="text-xs text-ink/40">Connect →</span>
          </button>`,
        ).join('')}
      </div>

      <p id="login-error" class="text-xs text-red-500 hidden text-center"></p>

      <div>
        <button id="show-manual" class="text-sm text-ink/45 underline underline-offset-2 w-full text-center">
          Choose another instance
        </button>
        <form id="login-form" class="hidden space-y-3 pt-3">
          <input
            id="instance-input"
            type="text"
            inputmode="url"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
            placeholder="your.instance"
            class="w-full bg-cream border border-ink/15 rounded-xl px-4 py-3
                   text-ink placeholder:text-ink/30 text-base
                   focus:outline-none focus:border-gold transition-colors"
          />
          <button type="submit" id="login-submit" class="btn-primary w-full">Connect</button>
        </form>
      </div>

      <p class="text-xs text-ink/40 text-center leading-relaxed">
        Mastodon accounts also work but are not recommended — follower management and archiving
        behave differently.
      </p>

      <div class="flex items-center justify-center gap-1.5">${dots()}</div>
      <button id="back" class="text-sm text-ink/45 underline underline-offset-2 text-center">Back</button>
    `;
    el.appendChild(wrap);

    const errorEl = wrap.querySelector('#login-error') as HTMLElement;
    const form = wrap.querySelector('#login-form') as HTMLFormElement;
    const input = wrap.querySelector('#instance-input') as HTMLInputElement;
    const submitBtn = wrap.querySelector('#login-submit') as HTMLButtonElement;
    const showManualBtn = wrap.querySelector('#show-manual') as HTMLButtonElement;
    const actionButtons = Array.from(
      wrap.querySelectorAll<HTMLButtonElement>('.instance-pick, #login-submit'),
    );

    input.value = instanceValue;
    input.addEventListener('input', () => {
      instanceValue = input.value;
    });

    async function connect(raw: string, btn: HTMLButtonElement) {
      const instance = raw.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (!instance) return;

      errorEl.classList.add('hidden');
      actionButtons.forEach((b) => (b.disabled = true));
      const original = btn.textContent;
      btn.textContent = 'Connecting...';

      try {
        await startOAuthFlow(instance);
      } catch (err) {
        errorEl.textContent = err instanceof Error ? err.message : 'Connection failed.';
        errorEl.classList.remove('hidden');
        actionButtons.forEach((b) => (b.disabled = false));
        btn.textContent = original;
      }
    }

    wrap.querySelectorAll<HTMLButtonElement>('.instance-pick').forEach((btn) => {
      btn.addEventListener('click', () => connect(btn.dataset.instance!, btn));
    });

    showManualBtn.addEventListener('click', () => {
      form.classList.remove('hidden');
      showManualBtn.classList.add('hidden');
      input.focus();
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void connect(input.value, submitBtn);
    });

    wrap.querySelector('#back')?.addEventListener('click', () => goTo(step - 1));
  }

  render();
  return el;
}
