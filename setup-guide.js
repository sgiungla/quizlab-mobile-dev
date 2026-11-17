export function installSetupGuide({ getState, request, openPreferences }) {
  const host = document.createElement('div');
  host.className = 'setup-guide';
  host.innerHTML = `<button id="quizlab-setup-open" class="btn secondary setup-open" type="button" hidden>Installa e ricevi avvisi</button>
    <dialog id="quizlab-setup" class="setup-dialog" aria-labelledby="quizlab-setup-title">
      <h2 id="quizlab-setup-title">Porta QuizLab con te 🌴</h2>
      <p>Ritrova lo studio dalla schermata Home o dal desktop e ricevi i tuoi promemoria.</p>
      <div class="setup-actions">
        <button id="quizlab-install" class="btn" type="button">Installa QuizLab</button>
        <button id="quizlab-notifications" class="btn secondary" type="button">Attiva notifiche</button>
      </div>
      <p id="quizlab-setup-status" role="status" aria-live="polite"></p>
      <form method="dialog"><button class="btn ghost" autofocus>Più tardi</button></form>
    </dialog>`;
  document.body.append(host);
  const dialog = host.querySelector('dialog');
  const open = host.querySelector('#quizlab-setup-open');
  const install = host.querySelector('#quizlab-install');
  const notifications = host.querySelector('#quizlab-notifications');
  const status = host.querySelector('[role="status"]');
  const apple = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const stored = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const remember = key => { try { localStorage.setItem(key, '1'); } catch {} };
  let installPrompt = null;
  let browserPush = null;
  let currentDevice = null;
  let deviceOwner = null;
  let lastKey = '';
  let generation = 0;
  let lastCheckAt = 0;
  let offeredTo = null;
  let checking = false;

  function installed() {
    return standalone() || stored('quizlab-installed-v1') === '1';
  }

  function pushReady() {
    const state = getState();
    return !!state.accountId && deviceOwner === state.accountId
      && browserPush?.permission === 'granted' && browserPush.subscriptionRegistered
      && currentDevice?.enabled === true && currentDevice.permission === 'granted'
      && currentDevice.has_subscription !== false
      && state.preferences?.pushEnabled === true;
  }

  function draw() {
    const state = getState();
    const ready = pushReady();
    const canInstall = !installed();
    install.hidden = !canInstall;
    notifications.hidden = ready;
    open.hidden = !state.ready || checking || ready && (!canInstall || !installPrompt);
    open.textContent = ready ? 'Installa QuizLab' : canInstall ? 'Installa e ricevi avvisi' : 'Attiva i tuoi avvisi';
    if (ready) {
      status.textContent = 'Notifiche attive su questo dispositivo. 🌿';
      if (dialog.open) dialog.close();
    } else if (apple && !standalone()) {
      status.textContent = 'Aggiungi QuizLab alla schermata Home da Safari, poi aprilo dalla nuova icona per attivare le notifiche.';
    } else if (!state.accountId) {
      status.textContent = 'Accedi al tuo account: ti guideremo poi nell’attivazione delle notifiche.';
    } else if (browserPush?.permission === 'denied') {
      notifications.textContent = 'Come riattivare le notifiche';
      status.textContent = 'Le notifiche sono bloccate nelle impostazioni del sito. Puoi riabilitarle dal browser e tornare qui.';
    } else {
      notifications.textContent = 'Attiva notifiche su questo dispositivo';
      status.textContent = 'Apri le preferenze, premi «Attiva notifiche su questo dispositivo» e scegli «Consenti» quando richiesto.';
    }
  }

  function show() {
    if (typeof dialog.showModal !== 'function') return;
    draw();
    if (!dialog.open) dialog.showModal();
  }

  function offer() {
    const state = getState();
    if (!state.ready || checking || pushReady() || document.querySelector('.study-overlay,.gb-overlay')) return;
    if (state.accountId && browserPush?.permission === 'default' && (!apple || standalone())) {
      const key = 'quizlab-notification-invite-seen-v2.' + state.accountId;
      if (!stored(key) && offeredTo !== key) {
        offeredTo = key;
        show();
      }
    } else if (!installed() && !stored('quizlab-setup-seen-v1') && !dialog.open) {
      show();
    }
  }

  async function update({ force = false, pushState = null } = {}) {
    const state = getState();
    const permission = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
    const key = [state.ready, state.accountId, state.deviceId, state.preferences?.pushEnabled, permission, installed()].join('|');
    if (!force && key === lastKey) return;
    lastKey = key;
    const run = ++generation;
    if (deviceOwner !== state.accountId) {
      deviceOwner = null;
      currentDevice = null;
      browserPush = null;
    }
    if (!state.ready) { checking = false; draw(); return; }
    checking = true;
    lastCheckAt = Date.now();
    draw();
    try {
      if (pushState) {
        browserPush = pushState.runtime;
        currentDevice = pushState.device;
        deviceOwner = state.accountId;
      } else {
        let subscription = null;
        if (permission === 'granted' && 'serviceWorker' in navigator) {
          const read = async () => (await navigator.serviceWorker.getRegistration())?.pushManager?.getSubscription();
          let timer;
          try {
            subscription = await Promise.race([read(), new Promise(resolve => { timer = setTimeout(() => resolve(null), 2500); })]);
          } finally { clearTimeout(timer); }
        }
        if (run !== generation) return;
        browserPush = { permission, subscriptionRegistered: !!subscription };
        if (state.accountId && subscription && (deviceOwner !== state.accountId || force)) {
          const devices = await request('devices');
          if (run !== generation || state.accountId !== getState().accountId) return;
          currentDevice = devices.find(device => device.device_id === state.deviceId) || null;
          deviceOwner = state.accountId;
        }
      }
    } catch {
      // Keep the last confirmed device state when its cloud check is unavailable.
    } finally {
      if (run === generation) { checking = false; draw(); offer(); }
    }
  }

  open.addEventListener('click', show);
  dialog.addEventListener('close', () => {
    remember('quizlab-setup-seen-v1');
    if (offeredTo) remember(offeredTo);
  });
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    draw();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    remember('quizlab-installed-v1');
    draw();
  });
  install.addEventListener('click', async () => {
    if (installPrompt) {
      const prompt = installPrompt;
      installPrompt = null;
      install.disabled = true;
      try {
        await prompt.prompt();
        await prompt.userChoice;
      } catch {
        installPrompt = null;
      } finally { install.disabled = false; draw(); }
      return;
    }
    status.textContent = apple
      ? 'In Safari tocca Condividi, poi Aggiungi alla schermata Home. Apri QuizLab dalla nuova icona.'
      : 'Nel menu di Chrome o Edge scegli Installa QuizLab oppure Aggiungi alla schermata Home.';
  });
  notifications.addEventListener('click', async () => {
    if (apple && !standalone()) { draw(); return; }
    if (!getState().accountId) {
      dialog.close();
      document.querySelector('#authEmail')?.focus();
      return;
    }
    dialog.close();
    try {
      await openPreferences();
    } catch (error) {
      status.textContent = error.message || 'Le preferenze non sono disponibili in questo momento. Riprova tra poco.';
      if (!dialog.open) dialog.showModal();
    }
  });
  function foreground() {
    if (document.visibilityState === 'visible' && Date.now() - lastCheckAt > 30000) update({ force: true });
  }
  window.addEventListener('focus', foreground);
  document.addEventListener('visibilitychange', foreground);
  return { update };
}
