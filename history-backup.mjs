import {archiveIsEncrypted, createHistoryArchive, decryptHistoryArchive, encryptHistoryArchive, readHistoryArchive} from './history-archive.mjs';
import {authorizeDrive, downloadDriveBackup, listDriveBackups, preloadDriveAuthorization, uploadDriveBackup} from './drive-history.mjs';
import {historyLimitRanges, imageCapacityUnits, readHistoryLimits, saveHistoryLimits} from './history-limits.mjs';
import {mergeImageHistory, pruneImageHistory, readImageHistory} from './image-history.mjs';
import {validatePromptBackup} from './prompt-history.mjs';
import {isSafeHistoryImage} from './image-file.mjs';
import {validGoogleClientId} from './google-oauth.mjs';

const driveClientKey = 'moonlight-history-drive-client';
const driveModeKey = 'moonlight-history-drive-client-mode';
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

export function initializeHistoryBackup({readPrompts, mergePrompts, applyPromptLimit, refreshHistory, cloud}) {
  const byId = id => document.getElementById(id);
  const exportButton = byId('exportHistory');
  const importButton = byId('importHistory');
  const historyFile = byId('historyFile');
  const fileStatus = byId('historyFileStatus');
  const limitsForm = byId('historyLimits');
  const limitsStatus = byId('historyLimitStatus');
  const connect = byId('connectDrive');
  const disconnect = byId('disconnectDrive');
  const loginHelp = byId('driveLoginHelp');
  const advanced = byId('driveAdvanced');
  const driveCard = byId('driveHistoryCard');
  const useCustomClient = byId('driveUseCustomClient');
  const customFields = byId('driveCustomClientFields');
  const clientId = byId('driveClientId');
  const driveActions = byId('driveHistoryActions');
  const backupList = byId('driveBackupList');
  const drivePassword = byId('drivePassphrase');
  const driveStatus = byId('driveHistoryStatus');
  const restore = byId('restoreFromDrive');
  const cloudEnabled = byId('cloudGalleryEnabled');
  const cloudInterval = byId('cloudGalleryInterval');
  const cloudSchedule = byId('cloudGallerySchedule');
  const galleryPassword = byId('cloudGalleryPassword');
  const galleryConfirm = byId('cloudGalleryConfirm');
  const cloudUnlock = byId('unlockCloudGallery');
  const cloudRestore = byId('restoreCloudGallery');
  const cloudOptimize = byId('optimizeCloudGallery');
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
  let syncTimer;
  let googleLogin = 'idle';

  const configuredClientId = document.querySelector('meta[name="moonlight-drive-client-id"]')?.content;
  const hostedClientId = validGoogleClientId(configuredClientId) ? configuredClientId : '';
  let savedMode;
  byId('driveOAuthOrigin').value = location.origin;
  try {
    clientId.value = localStorage.getItem(driveClientKey) || '';
    savedMode = localStorage.getItem(driveModeKey);
  } catch {}
  useCustomClient.checked = !hostedClientId || savedMode === 'custom'
    || (!savedMode && validGoogleClientId(clientId.value));
  advanced.open = useCustomClient.checked;
  for (const [key, {min, max}] of Object.entries(historyLimitRanges)) {
    Object.assign(limitsForm.elements.namedItem(key), {min, max});
  }

  function status(element, message, error = false) {
    element.textContent = message;
    element.classList.toggle('history-backup-error', error);
  }

  function selectedClientId() {
    const value = useCustomClient.checked ? clientId.value.trim() : hostedClientId;
    return validGoogleClientId(value) ? value : '';
  }

  function preloadLogin() {
    if (!selectedClientId() || googleLogin === 'loading' || googleLogin === 'ready') return;
    googleLogin = 'loading';
    render();
    void preloadDriveAuthorization().then(() => { googleLogin = 'ready'; })
      .catch(() => { googleLogin = 'failed'; }).finally(render);
  }

  function render() {
    const connected = Boolean(auth && auth.expires > Date.now());
    byId('driveHistoryState').textContent = connected ? '已连接' : '未连接';
    byId('driveHistoryState').classList.toggle('resource-ready', connected);
    const canConnect = Boolean(selectedClientId());
    connect.disabled = busy || !canConnect || googleLogin === 'idle' || googleLogin === 'loading';
    connect.textContent = connected ? '切换 Google 账号' : googleLogin === 'failed' ? '重试加载 Google 登录' : '使用 Google 登录';
    loginHelp.textContent = !hostedClientId && !canConnect ? '此站点尚未配置 Google 登录。可在高级设置使用自己的 OAuth 客户端。'
      : !canConnect ? '请填写有效的 Web 应用 Client ID，或切回使用站点的 Google 登录。'
      : googleLogin === 'loading' ? '正在加载 Google 登录…' : useCustomClient.checked ? '当前使用你自己的 Google OAuth 客户端。' : '';
    loginHelp.hidden = !loginHelp.textContent;
    disconnect.disabled = busy;
    disconnect.hidden = !connected;
    useCustomClient.disabled = busy || !hostedClientId;
    customFields.hidden = !useCustomClient.checked;
    clientId.disabled = busy;
    driveActions.disabled = busy || !connected;
    restore.disabled = !backupList.value;
    cloudEnabled.disabled = busy;
    cloudInterval.disabled = busy || !cloud.enabled;
    cloudSchedule.textContent = cloud.enabled && connected && cloud.interval * 60_000 >= auth.expires - Date.now()
      ? '间隔超过当前授权剩余时间。可手动同步，或缩短间隔。授权到期后需重新连接并解锁。'
      : '定时同步在本次 Drive 授权有效时运行。授权到期后需重新连接并解锁。';
    galleryPassword.disabled = galleryConfirm.disabled = busy || !connected || cloud.ready;
    cloudUnlock.disabled = busy || !connected;
    cloudUnlock.textContent = cloud.ready ? '锁定云图库' : '解锁云图库';
    cloudRestore.disabled = cloudOptimize.disabled = busy || !cloud.ready;
    for (const button of [exportButton, importButton, importSubmit, importClose, limitsForm.querySelector('button')]) button.disabled = busy;
  }

  function renderLimits(syncInputs = false) {
    const limits = readHistoryLimits();
    if (syncInputs) {
      for (const key of [...Object.keys(historyLimitRanges), 'imageCapacity', 'imageUnit']) {
        limitsForm.elements.namedItem(key).value = limits[key];
      }
    }
    byId('promptHistoryLimit').textContent = limits.promptCount ? '本地最多保留最近 ' + limits.promptCount + ' 条提示词' : '已暂停保存提示词历史';
    byId('imageHistoryLimit').textContent = limits.imageCount
      ? '本地最多保留最近 ' + limits.imageCount + ' 批图片，总计 ' + limits.imageCapacity + ' ' + limits.imageUnit
      : '已暂停保存生图历史';
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
    next.imageCapacity = limitsForm.elements.namedItem('imageCapacity').valueAsNumber;
    next.imageUnit = limitsForm.elements.namedItem('imageUnit').value;
    const previous = readHistoryLimits();
    const bytes = next.imageCapacity * imageCapacityUnits[next.imageUnit];
    if ((next.promptCount < previous.promptCount || next.imageCount < previous.imageCount || bytes < previous.imageBytes)
      && !window.confirm('调低上限可能清理较旧的本地历史。要保存吗？')) return;
    void run(limitsStatus, async () => {
      const saved = saveHistoryLimits(next);
      renderLimits(true);
      const promptsRemoved = applyPromptLimit(saved.promptCount);
      try {
        const images = await pruneImageHistory(saved);
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
    cloud.lock();
    restartSync();
    galleryPassword.value = galleryConfirm.value = '';
    drivePassword.value = '';
    showBackups([]);
    render();
  }

  function rememberDrive(authorization) {
    cloud.lock();
    restartSync();
    auth = authorization;
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => {
      disconnectDrive();
      if (!busy) status(driveStatus, 'Drive 授权已过期，请重新连接。');
    }, Math.max(0, auth.expires - Date.now()));
  }

  useCustomClient.onchange = () => {
    disconnectDrive();
    try { localStorage.setItem(driveModeKey, useCustomClient.checked ? 'custom' : 'hosted'); } catch {}
    if (useCustomClient.checked && !selectedClientId()) clientId.focus();
    preloadLogin();
  };
  clientId.oninput = () => {
    disconnectDrive();
    preloadLogin();
  };
  backupList.onchange = render;
  connect.onclick = () => {
    if (googleLogin === 'failed') { preloadLogin(); return; }
    const id = selectedClientId();
    if (!id || googleLogin !== 'ready') return;
    void run(driveStatus, async () => {
      const authorization = await authorizeDrive(id);
      const backups = await listDriveBackups(authorization);
      rememberDrive(authorization);
      showBackups(backups);
      if (useCustomClient.checked) {
        try { localStorage.setItem(driveClientKey, id); }
        catch { return '已连接 Google Drive。自定义 Client ID 只在当前页面保留。'; }
      }
      return '已连接 Google Drive。';
    });
  };
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

  async function syncCloud() {
    const result = await cloud.restore((completed, total) => status(driveStatus, '正在同步缩略图 · ' + completed + ' / ' + total));
    if (result.added || result.removed) refreshHistory();
    return '已同步 ' + result.added + ' 批缩略图。'
      + (result.limited ? '已按本机上限保留原图，剩余缩略图可待有空间时同步。' : '')
      + (result.removed ? '移除了 ' + result.removed + ' 批较旧的本地缩略图缓存。' : '')
      + (result.unavailable ? '有 ' + result.unavailable + ' 批暂不可恢复。' : '');
  }

  function restartSync() {
    clearInterval(syncTimer);
    if (cloud.enabled && cloud.ready) {
      syncTimer = setInterval(() => void run(driveStatus, syncCloud), cloud.interval * 60_000);
    }
  }

  cloudEnabled.checked = cloud.enabled;
  cloudInterval.value = cloud.interval;
  cloudEnabled.onchange = cloudInterval.onchange = () => {
    try {
      cloud.configure({enabled: cloudEnabled.checked, interval: cloudInterval.valueAsNumber});
      restartSync();
    } catch (error) {
      cloudEnabled.checked = cloud.enabled;
      cloudInterval.value = cloud.interval;
      status(driveStatus, error.message, true);
    }
    render();
  };
  cloudUnlock.onclick = () => run(driveStatus, async () => {
    if (cloud.ready) {
      cloud.lock();
      restartSync();
      return '云图库已锁定。';
    }
    const passphrase = galleryPassword.value;
    if (passphrase.length < 8) throw new Error('请输入至少 8 个字符的云图库口令。');
    const confirmation = galleryConfirm.value;
    galleryPassword.value = galleryConfirm.value = '';
    const authorization = auth;
    await cloud.unlock(authorization, passphrase, confirmation);
    if (auth !== authorization) {
      cloud.lock();
      throw new Error('Drive 授权已过期，请重新连接。');
    }
    restartSync();
    return cloud.enabled ? '云图库已解锁。' + await syncCloud() : '云图库已解锁。';
  });
  cloudRestore.onclick = () => run(driveStatus, syncCloud);
  cloudOptimize.onclick = () => {
    if (!window.confirm('原图上传并校验成功后，本地历史将只保留缩略图。要继续吗？')) return;
    void run(driveStatus, async () => {
      const result = await cloud.optimize((completed, total) => status(driveStatus, '正在验证云端原图 · ' + completed + ' / ' + total));
      refreshHistory();
      return '已将 ' + result.replaced + ' 批本地原图替换为缩略图。';
    });
  };

  renderLimits(true);
  showBackups([]);
  render();
  driveCard.addEventListener('pointerenter', preloadLogin, {once: true});
  driveCard.addEventListener('focusin', preloadLogin, {once: true});
  if (typeof IntersectionObserver === 'function') {
    const driveObserver = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        driveObserver.disconnect();
        preloadLogin();
      }
    }, {rootMargin: '200px 0px'});
    driveObserver.observe(driveCard);
  }
  window.addEventListener('storage', () => renderLimits());
}
