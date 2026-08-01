(function adminLoadingModule(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root?.document) root.AdminLoading = api.createAdminLoading(root);
}(typeof window !== 'undefined' ? window : globalThis, function factory(root) {
  'use strict';

  const SHOW_DELAY_MS = 200;
  const MIN_VISIBLE_MS = 250;
  const SLOW_MESSAGE_MS = 8000;
  const VERY_SLOW_MESSAGE_MS = 30000;
  const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const LOADING_MESSAGES = Object.freeze({
    default: { title: 'Processando...', message: 'Aguarde um momento.' },
    save: { title: 'Salvando alterações...', message: 'Não feche esta página.' },
    create: { title: 'Cadastrando...', message: 'Aguarde enquanto criamos o registro.' },
    update: { title: 'Atualizando...', message: 'Aguarde enquanto aplicamos as alterações.' },
    delete: { title: 'Excluindo registro...', message: 'Aguarde a conclusão.' },
    payment: { title: 'Confirmando pagamento...', message: 'Esta operação pode levar alguns segundos.' },
    upload: { title: 'Enviando arquivo...', message: 'Não feche esta página durante o envio.' },
    cancel: { title: 'Cancelando...', message: 'Aguarde a confirmação.' },
  });

  function createAdminLoading(env = root) {
    const document = env.document;
    const setTimer = env.setTimeout.bind(env);
    const clearTimer = env.clearTimeout.bind(env);
    const now = () => typeof env.Date?.now === 'function' ? env.Date.now() : Date.now();
    let pendingOperations = 0;
    let visibleSince = 0;
    let previousFocus = null;
    let showTimer = null;
    let hideTimer = null;
    let slowTimer = null;
    let verySlowTimer = null;
    let currentOptions = LOADING_MESSAGES.default;

    const element = id => document.getElementById(id);
    const overlay = () => element('adminLoadingOverlay');
    const title = () => element('adminLoadingTitle');
    const message = () => element('adminLoadingMessage');

    function clearOperationTimers() {
      if (showTimer) clearTimer(showTimer);
      if (hideTimer) clearTimer(hideTimer);
      if (slowTimer) clearTimer(slowTimer);
      if (verySlowTimer) clearTimer(verySlowTimer);
      showTimer = hideTimer = slowTimer = verySlowTimer = null;
    }

    function applyOptions(options = {}) {
      currentOptions = {
        title: String(options.title || currentOptions.title || LOADING_MESSAGES.default.title),
        message: String(options.message || currentOptions.message || LOADING_MESSAGES.default.message),
      };
      if (title()) title().textContent = currentOptions.title;
      if (message()) message().textContent = currentOptions.message;
    }

    function open() {
      showTimer = null;
      if (pendingOperations < 1 || !overlay()) return;
      previousFocus = document.activeElement;
      applyOptions(currentOptions);
      overlay().hidden = false;
      overlay().setAttribute('aria-hidden', 'false');
      document.body.classList.add('admin-loading-open');
      document.body.setAttribute('aria-busy', 'true');
      visibleSince = now();
      element('adminLoadingDialog')?.focus({ preventScroll: true });
      slowTimer = setTimer(() => {
        if (pendingOperations > 0 && message()) {
          message().textContent = 'A operação está demorando um pouco mais que o normal. Continue aguardando.';
        }
      }, SLOW_MESSAGE_MS);
      verySlowTimer = setTimer(() => {
        if (pendingOperations > 0 && message()) {
          message().textContent = 'Estamos aguardando a resposta do servidor.';
        }
      }, VERY_SLOW_MESSAGE_MS);
    }

    function close() {
      if (!overlay()) return;
      overlay().hidden = true;
      overlay().setAttribute('aria-hidden', 'true');
      document.body.classList.remove('admin-loading-open');
      document.body.removeAttribute('aria-busy');
      visibleSince = 0;
      const focusTarget = previousFocus;
      previousFocus = null;
      if (focusTarget?.isConnected && typeof focusTarget.focus === 'function') {
        focusTarget.focus({ preventScroll: true });
      }
    }

    function show(options = {}) {
      pendingOperations += 1;
      currentOptions = { ...LOADING_MESSAGES.default, ...options };
      if (pendingOperations === 1) {
        clearOperationTimers();
        showTimer = setTimer(open, SHOW_DELAY_MS);
      } else if (isVisible()) {
        applyOptions(currentOptions);
      }
      return pendingOperations;
    }

    function hide() {
      pendingOperations = Math.max(0, pendingOperations - 1);
      if (pendingOperations > 0) return pendingOperations;
      if (showTimer) {
        clearTimer(showTimer);
        showTimer = null;
      }
      if (!isVisible()) {
        clearOperationTimers();
        return 0;
      }
      const remaining = Math.max(0, MIN_VISIBLE_MS - (now() - visibleSince));
      if (hideTimer) clearTimer(hideTimer);
      hideTimer = setTimer(() => {
        clearOperationTimers();
        close();
      }, remaining);
      return 0;
    }

    function update(options = {}) {
      applyOptions(options);
    }

    function isVisible() {
      return Boolean(overlay() && !overlay().hidden);
    }

    async function run(task, options = {}) {
      show(options);
      try {
        return await task();
      } finally {
        hide();
      }
    }

    function pendingCount() { return pendingOperations; }

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && pendingOperations > 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);

    return { show, hide, update, isVisible, run, pendingCount, messages: LOADING_MESSAGES };
  }

  function optionsForAction(action, custom = {}) {
    return { ...(LOADING_MESSAGES[action] || LOADING_MESSAGES.default), ...custom };
  }

  return { createAdminLoading, optionsForAction, LOADING_MESSAGES, MUTATING_METHODS };
}));
