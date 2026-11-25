const clientPattern = /^[A-Za-z0-9_-]{4,220}\.apps\.googleusercontent\.com$/;

export function validGoogleClientId(clientId) {
  return typeof clientId === 'string' && clientPattern.test(clientId);
}

let googleScript;
export function loadGoogleOAuth() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve(globalThis.google.accounts.oauth2);
  googleScript ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    const failed = () => {
      script.remove();
      reject(new Error('无法加载 Google 登录，请检查网络后重试。'));
    };
    script.onload = () => {
      if (globalThis.google?.accounts?.oauth2) resolve(globalThis.google.accounts.oauth2);
      else failed();
    };
    script.onerror = failed;
    document.head.append(script);
  }).catch(error => {
    googleScript = undefined;
    throw error;
  });
  return googleScript;
}

export function requestGoogleToken(clientId, scope, permissionError) {
  const request = oauth => new Promise((resolve, reject) => {
    const client = oauth.initTokenClient({
      client_id: clientId,
      scope,
      include_granted_scopes: false,
      callback(response) {
        const seconds = Number(response.expires_in);
        if (typeof response.access_token !== 'string' || !response.access_token
          || !Number.isFinite(seconds) || seconds <= 0 || !oauth.hasGrantedAllScopes(response, scope)) {
          reject(new Error(permissionError));
          return;
        }
        resolve({token: response.access_token, expires: Date.now() + seconds * 1000});
      },
      error_callback(error) {
        reject(new Error(error.type === 'popup_failed_to_open'
          ? '浏览器拦截了 Google 登录窗口。请允许弹出窗口，再点击登录。'
          : 'Google 登录窗口已关闭或授权失败。'));
      },
    });
    client.requestAccessToken({prompt: 'select_account'});
  });
  const oauth = globalThis.google?.accounts?.oauth2;
  return oauth ? request(oauth) : loadGoogleOAuth().then(request);
}
