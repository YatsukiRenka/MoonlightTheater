export function isResponseTimeout(error, signal) {
  return error?.name === 'TimeoutError' || signal.reason?.name === 'TimeoutError';
}

export async function readResponseChunk(reader, signal) {
  try {
    return await reader.read();
  } catch (error) {
    const message = isResponseTimeout(error, signal) ? '读取接口响应超时。' : '读取接口响应时连接中断。';
    throw new Error(message, {cause: error});
  }
}

// Parse SSE lines incrementally so a preview can be shown before the final image.
export async function readImageStream({response, signal}, onEvent, maxBytes) {
  if (!response.body) throw new Error('接口未返回流式数据。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data = [];
  let bytes = 0;

  function dispatch() {
    if (!data.length) return;
    const payload = data.join('\n');
    data = [];
    if (payload !== '[DONE]') {
      let item;
      try { item = JSON.parse(payload); } catch { throw new Error('接口返回了无效的流式生图数据。'); }
      onEvent(item.type || event, item);
    }
    event = '';
  }

  try {
    for (;;) {
      const {value, done} = await readResponseChunk(reader, signal);
      bytes += value?.byteLength ?? 0;
      if (bytes > maxBytes) throw new Error('流式生图数据超过浏览器处理上限。');
      buffer += decoder.decode(value, {stream: !done});
      let start = 0;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n', start)) {
        const line = buffer.slice(start, end).replace(/\r$/, '');
        start = end + 1;
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (!line) dispatch();
      }
      buffer = buffer.slice(start);
      if (done) {
        if (buffer.startsWith('data:')) data.push(buffer.slice(5).trim());
        dispatch();
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
