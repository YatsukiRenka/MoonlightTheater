export function initializeImageSettings({save, google}) {
  const page = document.getElementById('settings');
  const connection = document.getElementById('resourceConnection');
  const googleOrigin = document.getElementById('oauthOrigin');
  const login = document.getElementById('settingsGoogle');
  const cards = [...page.querySelectorAll('[data-resource]')].map(form => ({
    form, id: form.dataset.resource, fields: form.querySelector('fieldset'),
    state: form.querySelector('[data-state]'), remove: form.querySelector('[data-remove]'),
    message: form.querySelector('[data-message]'), dirty: false,
  }));
  const oauth = cards.find(card => card.id === 'gemini-oauth');
  const custom = cards.find(card => card.id === 'custom');
  const format = custom.form.elements.namedItem('format');
  const urlHelp = document.getElementById('customURLHelp');
  googleOrigin.value = location.origin;
  let snapshot;
  let busy = false;

  function message(card, text, error = false) {
    card.message.textContent = text;
    card.message.classList.toggle('image-error', error);
  }

  function showURLHelp() {
    urlHelp.textContent = format.value === 'gemini'
      ? '例如 https://gateway.example/v1beta/models/{model}:generateContent'
      : '例如 https://gateway.example/v1/images/generations';
  }

  function render() {
    const configurable = snapshot?.canConfigure;
    connection.hidden = Boolean(configurable);
    connection.textContent = '浏览器未允许本站使用本地存储。';
    for (const card of cards) {
      const resource = snapshot?.resources?.[card.id];
      const connected = card === oauth && snapshot?.providers?.['gemini-oauth']?.connected;
      card.fields.disabled = !configurable || busy;
      card.remove.hidden = !resource?.saved;
      card.state.textContent = connected ? '已授权'
        : resource?.saved ? '已保存' : resource?.ready ? '已配置' : '未配置';
      card.state.classList.toggle('resource-ready', Boolean(resource?.ready));
      const keyField = card.form.elements.namedItem('key');
      if (keyField) keyField.placeholder = resource?.hasSecret ? '已保存，留空保留' : '';
      if (card === custom) card.form.querySelector('[data-clear-key]').hidden = !resource?.hasSecret;
      if (!card.dirty && resource) {
        for (const name of ['clientId', 'project', 'url', 'format', 'model']) {
          const field = card.form.elements.namedItem(name);
          if (field) field.value = resource[name];
        }
      }
    }
    login.hidden = !snapshot?.providers?.['gemini-oauth']?.ready;
    login.textContent = snapshot?.providers?.['gemini-oauth']?.connected ? '断开 Google 授权' : '使用 Google 登录';
    showURLHelp();
  }

  async function run(card, action) {
    if (busy) return;
    busy = true;
    message(card, '');
    render();
    try {
      const status = await action();
      if (status) message(card, status);
    } catch (error) {
      message(card, error.message, true);
    } finally {
      busy = false;
      render();
    }
  }

  for (const card of cards) {
    card.form.oninput = () => { card.dirty = true; };
    card.form.onsubmit = event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(card.form));
      if (values.clearKey) values.clearKey = true;
      run(card, async () => {
        await save(card.id, 'save', values);
        card.dirty = false;
        const keyField = card.form.elements.namedItem('key');
        if (keyField) keyField.value = '';
        if (card === custom) card.form.elements.namedItem('clearKey').checked = false;
        return '已保存到当前浏览器。';
      });
    };
    card.remove.onclick = () => run(card, async () => {
      await save(card.id, 'remove');
      card.dirty = false;
      card.form.reset();
      return '已移除本地配置。';
    });
  }

  format.onchange = showURLHelp;
  login.onclick = () => run(oauth, google);
  document.getElementById('copyOAuthOrigin').onclick = async () => {
    try {
      await navigator.clipboard.writeText(googleOrigin.value);
      message(oauth, '已复制 JavaScript 来源。');
    } catch {
      googleOrigin.focus();
      googleOrigin.select();
      message(oauth, '已选中 JavaScript 来源，可手动复制。');
    }
  };

  return {
    update(value) { snapshot = value; render(); },
  };
}
