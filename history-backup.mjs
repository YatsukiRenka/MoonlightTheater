import {archiveIsEncrypted, createHistoryArchive, decryptHistoryArchive, encryptHistoryArchive, readHistoryArchive} from './history-archive.mjs';
import {authorizeDrive, downloadDriveBackup, listDriveBackups, preloadDriveAuthorization, uploadDriveBackup} from './drive-history.mjs';
import {historyLimitRanges, readHistoryLimits, saveHistoryLimits} from './history-limits.mjs';
import {mergeImageHistory, pruneImageHistory, readImageHistory} from './image-history.mjs';
import {validatePromptBackup} from './prompt-history.mjs';
import {isSafeHistoryImage} from './image-file.mjs';

const driveClientKey = 'moonlight-history-drive-client';
const extension = '.mlhistory';
const mib = 1024 * 1024;
const formatSize = bytes => (Number(bytes) / mib).toFixed(1) + ' MiB';

async function chooseSaveFile(filename) {
  if (typeof window.showSaveFilePicker !== 'function') return null;
  try {
    return await window.showSaveFilePicker({
      suggestedName: filename,
      types: [{description: '月光剧场历史备份', accept: {'application/octet-stream': [extension]}}],
    });
  } catch (error) {
    if (error.name === 'SecurityError') return null;
    throw error;
  }
}

async function saveBackup(blob, filename, destination) {
  if (destination) {
    const stream = await destination.createWritable();
    try {
      await stream.write(blob);
      await stream.close();
    } catch (error) {
      await stream.abort().catch(() => {});
      throw error;
    }
    return;
  }
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function initializeHistoryBackup({readPrompts, mergePrompts, applyPromptLimit, refreshHistory}) {
  const byId = id => document.getElementById(id);
  const exportButton = byId('exportHistory');
  const importButton = byId('importHistory');
  const historyFile = byId('historyFile');
  const fileStatus = byId('historyFileStatus');
  const limitsForm = byId('historyLimits');
  const limitsStatus = byId('historyLimitStatus');
  const connect = byId('connectDrive');
  const disconnect = byId('disconnectDrive');
  const clientId = byId('driveClientId');
  const driveActions = byId('driveHistoryActions');
  const backupList = byId('driveBackupList');
  const drivePassword = byId('drivePassphrase');
  const driveStatus = byId('driveHistoryStatus');
  const restore = byId('restoreFromDrive');
  const importDialog = byId('historyImportDialog');
  const importForm = byId('historyImportForm');
  const importPassword = byId('importHistoryPassphrase');
  const importStatus = byId('historyImportStatus');
  const importClose = byId('closeHistoryImport');
  const importSubmit = importForm.querySelector('button[type="submit"]');
  let pendingFile;
  let busy = false;
  let auth;
  let expiryTimer;

  byId('driveOAuthOrigin').value = location.origin;
  try { clientId.value = localStorage.getItem(driveClientKey) || ''; } catch {}
  for (const [key, {min, max}] of Object.entries(historyLimitRanges)) {
    Object.assign(limitsForm.elements.namedItem(key), {min, max});
  }

  function status(element, message, error = false) {
    element.textContent = message;
    element.classList.toggle('history-backup-error', error);
  }

  function render() {
    const connected = Boolean(auth && auth.expires > Date.now());
    byId('driveHistoryState').textContent = connected ? '已连接' : '未连接';
    byId('driveHistoryState').classList.toggle('resource-ready', connected);
    connect.disabled = busy;
    disconnect.disabled = busy;
    disconnect.hidden = !connected;
    clientId.disabled = busy;
    driveActions.disabled = busy || !connected;
    restore.disabled = !backupList.value;
    for (const button of [exportButton, importButton, importSubmit, importClose, limitsForm.querySelector('button')]) button.disabled = busy;
  }

  function renderLimits(syncInputs = false) {
    const limits = readHistoryLimits();
    if (syncInputs) {
      for (const key of Object.keys(historyLimitRanges)) limitsForm.elements.namedItem(key).value = limits[key];
    }
    byId('promptHistoryLimit').textContent = limits.promptCount ? '本地最多保留最近 ' + limits.promptCount + ' 条提示词' : '已暂停保存提示词历史';
    byId('imageHistoryLimit').textContent = limits.imageCount
      ? '本地最多保留最近 ' + limits.imageCount + ' 批图片，总计 ' + limits.imageMiB + ' MiB' : '已暂停保存生图历史';
  }

  async function run(element, action) {
    if (busy) return;
    busy = true;
    status(element, '正在处理…');
    render();
    try {
      const message = await action();
      status(element, message || '');
    } catch (error) {
      if (element === driveStatus && (error.status === 401 || (auth && auth.expires <= Date.now()))) disconnectDrive();
      status(element, error.name === 'AbortError' ? '' : error.message, error.name !== 'AbortError');
    } finally {
      busy = false;
      render();
    }
  }

  async function makeArchive() {
    const prompts = readPrompts();
    const images = await readImageHistory();
    return createHistoryArchive({prompts, images});
  }

  async function mergeArchive(blob) {
    const {prompts, images} = await readHistoryArchive(blob);
    const validPrompts = validatePromptBackup(prompts);
    for (const record of images) {
      const validImages = await Promise.all(record.images.map(isSafeHistoryImage));
      if (!validImages.every(Boolean)) throw new Error('备份包含无效或不安全的图像文件。');
    }
    const imageResult = await mergeImageHistory(images);
    try {
      const promptResult = mergePrompts(validPrompts);
      const skipped = imageResult.skipped + imageResult.duplicates + promptResult.skipped + promptResult.duplicates;
      const removed = imageResult.removed + promptResult.removed;
      return '已新增 ' + promptResult.added + ' 条提示词、' + imageResult.added + ' 批生图。'
        + (skipped ? '已略过 ' + skipped + ' 项重复或超限记录。' : '')
        + (removed ? '已依照本地上限清理 ' + removed + ' 项较旧记录。' : '');
    } catch (error) {
      if (imageResult.added || imageResult.removed) throw new Error('生图已处理，提示词导入失败。' + error.message, {cause: error});
      throw error;
    } finally {
      refreshHistory();
    }
  }

  exportButton.onclick = () => run(fileStatus, async () => {
    const filename = 'moonlight-history-' + new Date().toLocaleDateString('sv-SE') + extension;
    const destination = await chooseSaveFile(filename);
    const archive = await makeArchive();
    await saveBackup(archive, filename, destination);
    return '已导出历史备份（' + formatSize(archive.size) + '）。';
  });
  importButton.onclick = () => historyFile.click();
  historyFile.onchange = () => {
    const file = historyFile.files[0];
    historyFile.value = '';
    if (!file) return;
    void run(fileStatus, async () => {
      if (await archiveIsEncrypted(file)) {
        pendingFile = file;
        importPassword.value = '';
        status(importStatus, '');
        importDialog.showModal();
        importPassword.focus();
        return '';
      }
      return mergeArchive(file);
    });
  };
  importClose.onclick = () => importDialog.close();
  importDialog.oncancel = event => { if (busy) event.preventDefault(); };
  importDialog.onclose = () => { pendingFile = undefined; importPassword.value = ''; };
  importForm.onsubmit = event => {
    event.preventDefault();
    if (!pendingFile || !importPassword.value) return;
    const password = importPassword.value;
    importPassword.value = '';
    void run(importStatus, async () => {
      const result = await mergeArchive(await decryptHistoryArchive(pendingFile, password));
      importDialog.close();
      status(fileStatus, result);
      return '';
    });
  };

  limitsForm.onsubmit = event => {
    event.preventDefault();
    const next = Object.fromEntries(Object.keys(historyLimitRanges)
      .map(key => [key, limitsForm.elements.namedItem(key).valueAsNumber]));
    const previous = readHistoryLimits();
    if (Object.keys(next).some(key => next[key] < previous[key])
      && !window.confirm('调低上限可能清理较旧的本地历史。要保存吗？')) return;
    void run(limitsStatus, async () => {
      saveHistoryLimits(next);
      renderLimits(true);
      const promptsRemoved = applyPromptLimit(next.promptCount);
      try {
        const images = await pruneImageHistory(next);
        return '已保存保留设置。' + (promptsRemoved || images.removed
          ? '清理了 ' + promptsRemoved + ' 条提示词、' + images.removed + ' 批生图。' : '');
      } catch (error) {
        throw new Error('上限已保存，生图历史暂时无法整理。' + error.message, {cause: error});
      } finally {
        refreshHistory();
      }
    });
  };

  function showBackups(backups) {
    const selected = backupList.value;
    const placeholder = new Option(backups.length ? '选择要恢复的备份' : '暂无备份', '');
    placeholder.disabled = backups.length > 0;
    backupList.replaceChildren(placeholder, ...backups.map(backup => {
      const date = new Date(backup.createdTime);
      const name = Number.isFinite(date.getTime()) ? date.toLocaleString() : backup.name;
      return new Option(name + (backup.size ? ' · ' + formatSize(backup.size) : ''), backup.id);
    }));
    backupList.value = backups.some(item => item.id === selected) ? selected : '';
  }

  function disconnectDrive() {
    auth = undefined;
    clearTimeout(expiryTimer);
    drivePassword.value = '';
    showBackups([]);
    render();
  }

  function rememberDrive(authorization) {
    auth = authorization;
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => {
      disconnectDrive();
      if (!busy) status(driveStatus, 'Drive 授权已过期，请重新连接。');
    }, Math.max(0, auth.expires - Date.now()));
  }

  clientId.onfocus = () => { void preloadDriveAuthorization().catch(() => {}); };
  clientId.oninput = disconnectDrive;
  backupList.onchange = render;
  connect.onclick = () => run(driveStatus, async () => {
    const id = clientId.value.trim();
    const authorization = await authorizeDrive(id);
    const backups = await listDriveBackups(authorization);
    rememberDrive(authorization);
    showBackups(backups);
    try { localStorage.setItem(driveClientKey, id); }
    catch { return '已连接 Google Drive。Client ID 只在当前页面保留。'; }
    return '已连接 Google Drive。';
  });
  disconnect.onclick = () => {
    disconnectDrive();
    status(driveStatus, '已断开当前页面的 Drive 连接。');
  };
  byId('refreshDriveBackups').onclick = () => run(driveStatus, async () => {
    showBackups(await listDriveBackups(auth));
    return '已刷新备份列表。';
  });
  byId('backupToDrive').onclick = () => run(driveStatus, async () => {
    const password = drivePassword.value;
    if (password.length < 8) throw new Error('请填写至少 8 个字符的备份口令。');
    drivePassword.value = '';
    const authorization = auth;
    const encrypted = await encryptHistoryArchive(await makeArchive(), password);
    await uploadDriveBackup(authorization, encrypted, {
      onProgress(done, total) { status(driveStatus, '正在上传加密备份 · ' + Math.round(100 * done / total) + '%'); },
    });
    try { showBackups(await listDriveBackups(authorization)); }
    catch { return '已备份到 Google Drive。备份列表暂时无法刷新。'; }
    return '已备份到 Google Drive（' + formatSize(encrypted.size) + '）。';
  });
  restore.onclick = () => run(driveStatus, async () => {
    const password = drivePassword.value;
    if (!password) throw new Error('请输入所选备份的解密口令。');
    drivePassword.value = '';
    const encrypted = await downloadDriveBackup(auth, backupList.value);
    return mergeArchive(await decryptHistoryArchive(encrypted, password));
  });

  renderLimits(true);
  showBackups([]);
  render();
  window.addEventListener('storage', () => renderLimits());
}
