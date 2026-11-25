import {icon} from './icons.mjs';
import {imageCapabilities, imageOptionFields, legacyImageOptions, validateReferenceImages} from './image-options.mjs';

export function initializeImageControls(optionsByModel, save, legacyAspect) {
  const byId = id => document.getElementById(id);
  const advanced = byId('imageAdvanced');
  const size = byId('imageShapeField');
  const advancedFields = byId('imageAdvancedFields');
  const note = byId('imageAdvancedNote');
  const picker = byId('imageReferences');
  const add = byId('imageAddReference');
  const list = byId('imageReferenceList');
  const notice = byId('imageReferenceStatus');
  const layer = byId('imageEditLayer');
  const layerType = byId('imageEditType');
  const layerFile = byId('imageLayerFile');
  const layerLabel = byId('imageLayerLabel');
  let caps;
  let key = '';
  let busy = false;
  let canAttach = false;
  let items = [];
  let current = {};

  function control(field) {
    const label = document.createElement('label');
    label.className = 'settinglabel';
    label.textContent = field.label;
    const input = document.createElement(field.values ? 'select' : 'input');
    input.name = field.key;
    input.disabled = busy;
    if (field.values) {
      input.append(...field.values.map(([value, title]) => new Option(title, value)));
      if (field.values.some(([value]) => value === current[field.key])) input.value = current[field.key];
    } else {
      Object.assign(input, {type: 'number', min: field.min, max: field.max, step: field.step, value: current[field.key] ?? ''});
    }
    input.oninput = () => {
      current[field.key] = input.value;
      save();
    };
    if (['size', 'output_format', 'mimeType', 'n', 'partial_images', 'search'].includes(field.key)) input.onchange = () => {
      renderSettings();
      if (field.key === 'size') size.querySelector('select')?.focus();
      else advancedFields.elements.namedItem(field.key)?.focus();
    };
    label.append(input);
    return label;
  }

  function renderSettings() {
    advanced.hidden = !caps;
    size.replaceChildren();
    advancedFields.replaceChildren();
    if (!caps) return;
    const [sizeField, ...fields] = imageOptionFields(caps, current, items.length > 0);
    size.append(control(sizeField));
    advancedFields.append(...fields.map(control));
    advancedFields.disabled = busy;
    layer.hidden = !canAttach || caps.format !== 'openai' || !items.length;
    const modes = ['', 'mask', ...(caps.modern ? ['markup'] : [])];
    const selectedType = layer.hidden ? '' : layerType.value;
    const selected = modes.includes(selectedType) ? selectedType : '';
    if (!selected) layerFile.value = '';
    layerType.replaceChildren(...modes.map(value => new Option({mask: '遮罩', markup: '标注图', '': '关闭'}[value], value)));
    layerType.value = selected;
    layerLabel.hidden = !selected;
    layerType.disabled = busy;
    layerFile.disabled = busy || !selected;
    const notes = [];
    if (caps.format === 'gemini' || (current.partial_images && !['svg', 'gif'].includes(current.output_format))) {
      if (Number(current.n) > 1) notes.push('多张图会分次请求，各次分别计费。');
    }
    if (current.search && caps.search.includes(current.search)) notes.push('Google 搜索可能另外计费。');
    if (caps.v26 && ['svg', 'gif'].includes(current.output_format)) notes.push('SVG 和 GIF 需要供应商开放对应权限。');
    note.textContent = notes.join(' ');
    note.hidden = !notes.length;
  }

  function showNotice(message = '') {
    notice.hidden = !message;
    notice.textContent = message;
  }

  function renderReferences() {
    add.disabled = busy || !canAttach || (caps && items.length >= caps.maxReferences);
    add.title = !canAttach && caps ? '请在设置中配置参考图接口' : '添加参考图片';
    list.hidden = !items.length;
    list.replaceChildren(...items.map(({file, url}, index) => {
      const item = document.createElement('li');
      const image = document.createElement('img');
      image.src = url;
      image.alt = file.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'image-remove-reference';
      remove.innerHTML = icon('x');
      remove.setAttribute('aria-label', '移除参考图片 ' + (index + 1));
      remove.disabled = busy;
      remove.onclick = () => {
        URL.revokeObjectURL(url);
        items.splice(index, 1);
        if (index === 0) layerFile.value = '';
        showNotice();
        renderSettings();
        renderReferences();
        (list.querySelectorAll('button')[index] || list.querySelector('button') || add).focus();
      };
      item.append(image, remove);
      return item;
    }));
  }

  add.onclick = () => picker.click();
  picker.onchange = () => {
    const selected = [...picker.files];
    picker.value = '';
    if (!selected.length || !caps) return;
    try {
      validateReferenceImages([...items.map(item => item.file), ...selected], caps);
      items.push(...selected.map(file => ({file, url: URL.createObjectURL(file)})));
      showNotice('已添加 ' + items.length + ' 张参考图。');
      renderSettings();
      renderReferences();
    } catch (error) { showNotice(error.message); }
  };
  layerType.onchange = () => {
    layerFile.value = '';
    layerLabel.hidden = !layerType.value;
    layerFile.disabled = !layerType.value;
  };

  return {
    update(provider, format, model, pending, supportsReferences) {
      const next = model ? provider + ':' + format + ':' + model : '';
      if (next !== key) {
        key = next;
        current = key ? (optionsByModel[key] ??= legacyImageOptions(format, legacyAspect)) : {};
        caps = key ? imageCapabilities(provider, format, model) : null;
        layerType.value = '';
        layerFile.value = '';
        showNotice();
      }
      busy = pending;
      canAttach = Boolean(caps && supportsReferences);
      renderSettings();
      renderReferences();
    },
    capture() {
      const references = items.map(item => item.file);
      if (references.length && !canAttach) throw new Error('当前接口未配置参考图编辑地址。请配置地址或移除参考图。');
      const type = layerType.value;
      const file = layerFile.files[0];
      if (type && !file) throw new Error('请选择要上传的透明 PNG。');
      return {options: {...current}, references, editLayer: type && file ? {type, file} : undefined};
    },
  };
}
