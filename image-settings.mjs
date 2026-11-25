import {apiProviderNames} from './api-resources.mjs';
import {modelPrice, priceLabel} from './image-usage.mjs';

export function setModelOptions(select, ids, value, placeholder) {
  const options = select.options;
  const empty = options[0];
  if (options.length !== ids.length + 1 || empty?.value !== '' || empty.text !== placeholder
    || empty.disabled !== Boolean(ids.length) || ids.some((id, index) => options[index + 1].value !== id)) {
    const first = new Option(placeholder, '');
    first.disabled = Boolean(ids.length);
    select.replaceChildren(first, ...ids.map(id => new Option(id, id)));
  }
  const choice = ids.includes(value) ? value : '';
  if (select.value !== choice) select.value = choice;
}

export function initializeImageSettings({verify, save, remove, google}) {
  const byId = id => document.getElementById(id);
  const list = byId('apiResourceList');
  const empty = byId('apiResourceEmpty');
  const add = byId('addApiResource');
  const connection = byId('resourceConnection');
  const listFeedback = byId('resourceFeedback');
  const dialog = byId('apiResourceEditor');
  const close = byId('closeApiResource');
  const form = byId('apiResourceForm');
  const fields = form.querySelector('[data-resource-fields]');
  const formFeedback = byId('apiResourceEditorFeedback');
  const nameInput = form.elements.namedItem('name');
  const providerInput = form.elements.namedItem('provider');
  const keyInput = form.elements.namedItem('key');
  const clearKey = form.elements.namedItem('clearKey');
  const format = form.elements.namedItem('format');
  const model = form.elements.namedItem('model');
  const price = form.querySelector('[data-price]');
  const verifyButton = form.querySelector('[data-verify]');
  const saveButton = form.querySelector('[type="submit"]');
  const origin = byId('oauthOrigin');
  const editsLabel = byId('customEditsLabel');
  const transportFields = ['clientId', 'project', 'url', 'format', 'modelsURL', 'editsURL'];
  const customFields = form.querySelector('[data-provider-fields="custom"]');
  const keyFields = form.querySelector('[data-provider-fields="key"]');
  const oauthFields = form.querySelector('[data-provider-fields="oauth"]');
  let rows;
  let busy = false;
  let editingId;
  let selectedModel = '';
  let verification;
  let connectionChanged = false;
  let opener;

  origin.defaultValue = location.origin;
  const providerPlaceholder = new Option('选择接口类型', '');
  providerPlaceholder.disabled = true;
  providerInput.append(providerPlaceholder, ...Object.entries(apiProviderNames).map(([id, label]) => new Option(label, id)));

  function feedback(element, message, error = false) {
    element.textContent = message;
    element.classList.toggle('image-error', error);
  }

  function action(label, handler, accessibleLabel = label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = label;
    button.setAttribute('aria-label', accessibleLabel);
    button.disabled = busy;
    button.onclick = handler;
    return button;
  }

  function resourceRow(row) {
    const item = document.createElement('li');
    item.className = 'panel resource-row';
    item.dataset.resource = row.id;
    item.dataset.provider = row.provider;
    const info = document.createElement('div');
    info.className = 'resource-row-info';
    const title = document.createElement('h2');
    title.textContent = row.name;
    const details = document.createElement('p');
    details.className = 'resource-row-details';
    const label = apiProviderNames[row.provider] || row.provider;
    details.textContent = row.model ? label + ' · 默认模型 ' + row.model : label;
    info.append(title, details);
    const status = document.createElement('span');
    status.className = 'resource-state';
    const oauth = row.provider === 'gemini-oauth';
    status.textContent = row.ready ? oauth ? (row.connected ? '已授权' : '待授权') : '可用' : '待验证';
    status.classList.toggle('resource-ready', row.ready && (!oauth || row.connected));
    const actions = document.createElement('div');
    actions.className = 'resource-row-actions';
    actions.append(action('编辑', event => edit(row, event.currentTarget), '编辑资源 ' + row.name));
    if (oauth && row.ready) {
      const text = row.connected ? '断开 Google 授权' : '连接 Google';
      actions.append(action(text, () => run(listFeedback, () => google(row.id)), text + ' · ' + row.name));
    }
    actions.append(action('移除', () => {
      if (!window.confirm('移除「' + row.name + '」的本地资源配置？')) return;
      void run(listFeedback, async () => {
        await remove(row.id);
        return '已移除「' + row.name + '」。';
      });
    }, '移除资源 ' + row.name));
    item.append(info, status, actions);
    return item;
  }

  function renderList() {
    connection.hidden = Array.isArray(rows);
    connection.textContent = connection.hidden ? '' : '浏览器未允许本站使用本地存储。';
    add.disabled = busy || !Array.isArray(rows);
    empty.hidden = !rows || rows.length > 0;
    list.replaceChildren(...(rows || []).map(resourceRow));
  }

  function renderEditor() {
    const provider = providerInput.value;
    const row = editingId && rows?.find(item => item.id === editingId);
    const custom = provider === 'custom';
    const oauth = provider === 'gemini-oauth';
    const usesKey = custom || provider === 'openai' || provider === 'gemini';
    fields.disabled = busy || !Array.isArray(rows) || Boolean(editingId && !row);
    close.disabled = busy;
    providerInput.disabled = Boolean(editingId);
    customFields.hidden = customFields.disabled = !custom;
    keyFields.hidden = keyFields.disabled = !usesKey;
    oauthFields.hidden = oauthFields.disabled = !oauth;
    editsLabel.hidden = !custom || format.value !== 'openai';
    form.elements.namedItem('editsURL').disabled = editsLabel.hidden;
    byId('customURLHelp').textContent = format.value === 'gemini'
      ? '例如 https://gateway.example/v1beta/models/{model}:generateContent'
      : '例如 https://gateway.example/v1/images/generations';
    byId('apiResourceKeyLabel').textContent = custom ? '网关 API Key（选填）' : (apiProviderNames[provider] || '') + ' API Key';
    keyInput.placeholder = row?.hasSecret ? '•••••••• · 留空保留' : '';
    keyInput.required = usesKey && !custom && !row?.hasSecret;
    clearKey.closest('label').hidden = clearKey.disabled = !custom || !row?.hasSecret;
    keyInput.disabled = !clearKey.disabled && clearKey.checked;

    const models = verification?.models ?? (!connectionChanged && row?.ready ? row.models : []) ?? [];
    setModelOptions(model, models, selectedModel, models.length ? '请选择模型' : '验证后获取模型');
    model.disabled = !models.length;
    verifyButton.textContent = oauth ? '授权并获取模型' : '验证并获取模型';
    verifyButton.disabled = !provider;
    saveButton.disabled = !model.value;
    price.hidden = !model.value;
    price.textContent = model.value ? priceLabel(modelPrice(provider, model.value, verification?.prices || row?.prices)) : '';
  }

  function render() {
    renderList();
    if (dialog.open) renderEditor();
  }

  async function run(element, work) {
    if (busy) return;
    busy = true;
    feedback(element, '');
    render();
    try {
      const message = await work();
      if (message) feedback(element, message);
    } catch (error) {
      feedback(element, error.message, true);
    } finally {
      busy = false;
      render();
    }
  }

  function edit(row, button) {
    editingId = row?.id;
    opener = button;
    verification = undefined;
    connectionChanged = false;
    selectedModel = row?.model || '';
    form.reset();
    nameInput.value = row?.name || '';
    providerInput.value = row?.provider || '';
    for (const field of transportFields) form.elements.namedItem(field).value = row?.[field] || (field === 'format' ? 'openai' : '');
    byId('apiResourceEditorTitle').textContent = row ? '编辑 API 资源' : '添加 API 资源';
    feedback(formFeedback, '');
    renderEditor();
    dialog.showModal();
    (row ? nameInput : providerInput).focus();
  }

  function values() {
    const draft = Object.fromEntries(new FormData(form));
    delete draft.name;
    delete draft.provider;
    if (draft.clearKey) draft.clearKey = true;
    return draft;
  }

  function invalidateConnection() {
    verification = undefined;
    connectionChanged = true;
    feedback(formFeedback, '');
  }

  form.oninput = event => {
    const {target} = event;
    if (target === providerInput) {
      for (const field of transportFields) form.elements.namedItem(field).value = field === 'format' ? 'openai' : '';
      keyInput.value = '';
      clearKey.checked = false;
      selectedModel = '';
      invalidateConnection();
    } else if (target === model) selectedModel = model.value;
    else if (target !== nameInput) invalidateConnection();
    renderEditor();
  };
  verifyButton.onclick = () => {
    if (!form.reportValidity() || busy) return;
    const input = values();
    void run(formFeedback, async () => {
      feedback(formFeedback, '正在验证并获取模型…');
      verification = await verify(providerInput.value, input, editingId);
      return '已获取 ' + verification.models.length + ' 个模型。';
    });
  };
  form.onsubmit = event => {
    event.preventDefault();
    if (saveButton.disabled || fields.disabled || busy) return;
    const resource = {id: editingId, provider: providerInput.value, name: nameInput.value.trim(), values: values(), verification};
    void run(formFeedback, async () => {
      const saved = await save(resource);
      feedback(listFeedback, '已保存「' + (saved?.name || resource.name || apiProviderNames[resource.provider]) + '」。');
      dialog.close();
    });
  };
  add.onclick = event => edit(undefined, event.currentTarget);
  close.onclick = () => dialog.close();
  dialog.oncancel = event => { if (busy) event.preventDefault(); };
  dialog.onclose = () => {
    keyInput.value = '';
    verification = undefined;
    if (opener?.isConnected) opener.focus();
    else add.focus();
  };
  byId('copyOAuthOrigin').onclick = async () => {
    try {
      await navigator.clipboard.writeText(origin.value);
      feedback(formFeedback, '已复制 JavaScript 来源。');
    } catch {
      origin.focus();
      origin.select();
      feedback(formFeedback, '已选中 JavaScript 来源，可手动复制。');
    }
  };

  return {
    update(value) { rows = value; render(); },
  };
}
