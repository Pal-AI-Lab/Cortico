(() => {
  'use strict';

  const stage = document.getElementById('stage');
  const query = new URLSearchParams(location.search);
  const editorPreview = query.has('preview');
  if (query.has('bg') || query.has('preview')) document.body.classList.add('preview');

  let design = null;
  let builtinStyles = [];
  let announcement = { text: '' };
  let videoQueue = { items: [] };
  let hasEditorDraft = false;
  const feeds = new Map();
  const horizontalLanes = new Map();
  const agentTypings = new Map();
  const mockTimers = new Set();
  let typingToken = 0;
  let mockToken = 0;
  let activeMockComponentId = '';

  if (editorPreview) document.body.dataset.wallMode = 'dark';

  const source = new EventSource('/stream');
  source.onmessage = (message) => {
    let packet;
    try { packet = JSON.parse(message.data); } catch { return; }
    if (packet.type === 'snapshot' || packet.type === 'state') {
      if (editorPreview && hasEditorDraft) {
        builtinStyles = Array.isArray(packet.builtinStyles) ? packet.builtinStyles : builtinStyles;
        announcement = packet.agentAnnouncement || announcement;
        videoQueue = packet.videoQueue || videoQueue;
        updateAnnouncement();
        updateVideoQueues();
        return;
      }
      applyState(packet);
      return;
    }
    if (packet.type === 'announcement' && packet.agentAnnouncement) {
      announcement = packet.agentAnnouncement;
      updateAnnouncement();
      return;
    }
    if (packet.type === 'video-queue' && packet.videoQueue) {
      videoQueue = packet.videoQueue;
      updateVideoQueues();
      return;
    }
    if (packet.type === 'audience' && packet.event) renderAudience(packet.event);
  };

  addEventListener('message', (message) => {
    if (!editorPreview) return;
    if (message.origin !== location.origin || message.source !== parent) return;
    const packet = message.data;
    if (!packet || typeof packet !== 'object') return;
    if (packet.type === 'overlay-editor-preview' && packet.design) {
      hasEditorDraft = true;
      design = packet.design;
      builtinStyles = Array.isArray(packet.builtinStyles) ? packet.builtinStyles : builtinStyles;
      if (packet.wallMode === 'light' || packet.wallMode === 'dark') {
        document.body.dataset.wallMode = packet.wallMode;
      }
      activeMockComponentId = typeof packet.mockComponentId === 'string' ? packet.mockComponentId : '';
      renderScene();
      if (Array.isArray(packet.events)) packet.events.forEach(renderAudience);
      if (activeMockComponentId) runComponentMock(activeMockComponentId);
      return;
    }
    if (packet.type === 'overlay-editor-audience' && packet.event) renderAudience(packet.event);
  });
  if (editorPreview) parent.postMessage({ type: 'overlay-editor-ready' }, location.origin);

  addEventListener('resize', fitStage);

  function applyState(packet) {
    design = packet.design || design;
    builtinStyles = Array.isArray(packet.builtinStyles) ? packet.builtinStyles : builtinStyles;
    announcement = packet.agentAnnouncement || announcement;
    videoQueue = packet.videoQueue || videoQueue;
    renderScene();
  }

  function renderScene() {
    if (!design) return;
    cancelAgentTypings();
    cancelMockTimers();
    for (const track of stage.querySelectorAll('.scroll-track')) {
      for (const animation of track.getAnimations()) animation.cancel();
    }
    feeds.clear();
    horizontalLanes.clear();
    stage.replaceChildren();
    stage.style.width = `${design.canvas.width}px`;
    stage.style.height = `${design.canvas.height}px`;
    const components = new Map(design.components.map((item) => [item.id, item]));
    const placements = [...design.placements].filter((item) => item.visible).sort((a, b) => a.z - b.z);
    for (const placement of placements) {
      const component = components.get(placement.componentId);
      if (!component) continue;
      renderPlacement(component, placement);
    }
    fitStage();
  }

  function renderPlacement(component, placement, isMock = false) {
    const element = document.createElement('section');
    element.className = `overlay-component ${component.kind}`;
    element.dataset.componentId = component.id;
    element.dataset.placementId = placement.id;
    if (isMock) element.classList.add('editor-mock-placement');
    Object.assign(element.style, {
      left: `${placement.x}px`,
      top: `${placement.y}px`,
      width: `${placement.width}px`,
      height: `${placement.height}px`,
      zIndex: String(placement.z),
    });
    applyPanelStyle(element, styleById(component.styleId));
    const content = componentFrame(element, component);
    fillComponent(element, content, component, placement.id);
    stage.appendChild(element);
    return element;
  }

  function componentFrame(element, component) {
    const content = document.createElement('div');
    content.className = 'component-content';
    const title = component.title;
    if (!title || !title.text) {
      element.appendChild(content);
      return content;
    }
    element.classList.add('has-title', `title-${title.position}`);
    const band = document.createElement('div');
    band.className = `component-title align-${title.align}`;
    band.textContent = title.text;
    applyTextStyle(band, title.style);
    if (title.position === 'bottom' || title.position === 'right') element.append(content, band);
    else element.append(band, content);
    return content;
  }

  function fillComponent(element, content, component, placementId) {
    const style = styleById(component.styleId);
    if (component.kind === 'danmaku') {
      const feed = document.createElement('div');
      feed.className = `danmaku-feed ${component.axis}`;
      if (component.axis === 'vertical') feed.style.rowGap = `${component.gap}px`;
      applyEdgeFade(feed, component.axis, component.edgeFadePx);
      content.appendChild(feed);
      const groupFontSizes = Array.isArray(design.groups)
        ? design.groups.flatMap((group) => [group.username && group.username.fontSize, group.body && group.body.fontSize])
        : [];
      const maxFontSize = Math.max(style.username.fontSize, style.body.fontSize, ...groupFontSizes.filter(Number.isFinite));
      feeds.set(placementId, {
        key: placementId,
        element: feed,
        component,
        style,
        laneHeight: maxFontSize * 1.5 + component.gap,
      });
      return;
    }
    if (component.kind === 'fixed-notice') {
      content.appendChild(textElement(component.text, style.body));
      return;
    }
    if (component.kind === 'agent-notice') {
      renderAgentNotice(element, content, component, placementId, style.body);
      return;
    }
    if (component.kind === 'video-queue') {
      renderVideoQueue(element, content, component, style, videoQueue.items);
      return;
    }
    if (component.kind === 'image') {
      element.classList.add('image-component');
      const image = document.createElement('img');
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      const source = componentImageSource(component);
      if (source) image.src = source;
      image.style.objectFit = component.fit;
      image.style.opacity = String(component.opacity);
      content.appendChild(image);
      return;
    }
    if (component.kind === 'scroll-notice') {
      const viewport = document.createElement('div');
      viewport.className = 'scroll-viewport';
      applyEdgeFade(viewport, component.axis, component.edgeFadePx);
      const track = document.createElement('div');
      track.className = `scroll-track ${component.axis}`;
      viewport.appendChild(track);
      content.appendChild(viewport);
      restartNotice(track, viewport, component, style.body);
    }
  }

  function renderAudience(event) {
    for (const feed of feeds.values()) {
      if (!acceptsAudience(feed.component, event)) continue;
      renderAudienceInto(feed, event);
    }
  }

  function acceptsAudience(component, event) {
    return component.admission === 'all' || component.admission === event.eventKind;
  }

  function renderAudienceInto(feed, event) {
    const item = audienceElement(event, feed);
    if (feed.component.axis === 'vertical') appendVertical(feed, item);
    else launchHorizontal(feed, item);
  }

  function updateAnnouncement() {
    if (!design) return;
    const components = new Map(design.components.map((item) => [item.id, item]));
    for (const element of stage.querySelectorAll('.agent-notice')) {
      const component = components.get(element.dataset.componentId);
      if (!component || component.kind !== 'agent-notice') continue;
      if (component.id === activeMockComponentId) continue;
      const content = element.querySelector('.component-content');
      if (!content) continue;
      renderAgentNotice(
        element,
        content,
        component,
        element.dataset.placementId,
        styleById(component.styleId).body,
      );
    }
  }

  function updateVideoQueues() {
    if (!design) return;
    const components = new Map(design.components.map((item) => [item.id, item]));
    for (const element of stage.querySelectorAll('.video-queue')) {
      const component = components.get(element.dataset.componentId);
      if (!component || component.kind !== 'video-queue') continue;
      if (component.id === activeMockComponentId) continue;
      const content = element.querySelector('.component-content');
      if (content) renderVideoQueue(element, content, component, styleById(component.styleId), videoQueue.items);
    }
  }

  /** BV 号与序号用样式的用户名文字，备注用正文文字；放不下的备注以省略号截断。 */
  function renderVideoQueue(element, content, component, style, items) {
    const list = Array.isArray(items) ? items : [];
    element.hidden = !list.length && component.hideWhenEmpty;
    content.replaceChildren();
    if (element.hidden) return;
    if (!list.length) {
      content.appendChild(textElement(component.emptyText, style.body));
      return;
    }
    const queue = document.createElement('ol');
    queue.className = `video-queue-list ${component.axis}`;
    queue.style.gap = `${component.gap}px`;
    list.forEach((item, index) => {
      const row = document.createElement('li');
      row.className = 'video-queue-item';
      const bvid = document.createElement('span');
      bvid.className = 'video-queue-bvid';
      bvid.textContent = component.showIndex ? `${index + 1}. ${item.bvid}` : item.bvid;
      applyTextStyle(bvid, style.username);
      row.appendChild(bvid);
      if (item.note) {
        const note = document.createElement('span');
        note.className = 'video-queue-note';
        note.textContent = item.note;
        applyTextStyle(note, style.body);
        row.appendChild(note);
      }
      queue.appendChild(row);
    });
    content.appendChild(queue);
  }

  function audienceElement(event, feed) {
    const item = document.createElement('div');
    item.className = 'audience-item';
    item.dataset.eventKind = event.eventKind;
    const group = Array.isArray(design.groups) ? design.groups.find((entry) => entry.id === event.groupId) : null;
    const usernameStyle = Object.assign({}, feed.style.username, group ? group.username : null);
    const bodyStyle = Object.assign({}, feed.style.body, group ? group.body : null);
    if (feed.component.showAvatar) item.appendChild(avatarElement(event, usernameStyle.color));
    const username = document.createElement('span');
    username.className = 'audience-name';
    username.textContent = truncateDisplay(event.username, feed.component.usernameMaxChars);
    applyTextStyle(username, usernameStyle);
    const body = document.createElement('span');
    body.className = 'audience-body';
    body.textContent = truncateDisplay(event.body, feed.component.bodyMaxChars);
    applyTextStyle(body, bodyStyle);
    item.append(username, body);
    return item;
  }

  function truncateDisplay(value, maxChars) {
    const characters = Array.from(String(value ?? ''));
    const limit = Math.max(0, Math.floor(Number(maxChars) || 0));
    if (!limit || characters.length <= limit) return characters.join('');
    if (limit === 1) return '…';
    return `${characters.slice(0, limit - 1).join('')}…`;
  }

  function avatarElement(event, color) {
    if (event.avatarUrl) {
      const image = document.createElement('img');
      image.className = 'audience-avatar';
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      image.src = event.avatarUrl;
      image.addEventListener('error', () => image.replaceWith(avatarFallback(event.username, color)), { once: true });
      return image;
    }
    return avatarFallback(event.username, color);
  }

  function avatarFallback(username, color) {
    const fallback = document.createElement('span');
    fallback.className = 'audience-avatar fallback';
    fallback.textContent = Array.from(username || '?')[0] || '?';
    fallback.style.color = color;
    return fallback;
  }

  function renderAgentNotice(element, content, component, placementId, style) {
    const hidden = !announcement.text && component.hideWhenEmpty;
    element.hidden = hidden;
    if (hidden) {
      stopAgentTyping(placementId);
      content.replaceChildren();
      return;
    }
    renderAgentText(content, announcement.text || component.emptyText, style, component.typingMs, placementId);
  }

  function renderAgentText(content, value, style, interval, placementId) {
    stopAgentTyping(placementId);
    content.replaceChildren();
    const element = textElement('', style);
    element.classList.add('agent-typing');
    content.appendChild(element);
    const characters = Array.from(value);
    const delay = Math.max(0, Number(interval) || 0);
    if (!delay || characters.length === 0) {
      element.textContent = value;
      return;
    }

    const text = document.createTextNode('');
    const cursor = document.createElement('span');
    cursor.className = 'agent-typing-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    element.append(text, cursor);
    const token = ++typingToken;
    const state = { token, timer: 0 };
    agentTypings.set(placementId, state);
    let index = 0;
    const typeNext = () => {
      const current = agentTypings.get(placementId);
      if (!current || current.token !== token) return;
      text.data += characters[index];
      index += 1;
      if (index < characters.length) {
        current.timer = setTimeout(typeNext, delay);
        return;
      }
      cursor.remove();
      agentTypings.delete(placementId);
    };
    state.timer = setTimeout(typeNext, delay);
  }

  function stopAgentTyping(placementId) {
    const state = agentTypings.get(placementId);
    if (!state) return;
    clearTimeout(state.timer);
    agentTypings.delete(placementId);
  }

  function cancelAgentTypings() {
    typingToken += 1;
    for (const state of agentTypings.values()) clearTimeout(state.timer);
    agentTypings.clear();
  }

  function runComponentMock(componentId) {
    if (!design) return;
    cancelMockTimers();
    const component = design.components.find((item) => item.id === componentId);
    if (!component) return;

    let elements = Array.from(stage.children).filter((element) => element.dataset.componentId === componentId);
    if (elements.length === 0) {
      const placement = mockPlacement(component);
      elements = [renderPlacement(component, placement, true)];
      fitStage();
    }
    for (const element of elements) element.hidden = false;

    const token = mockToken;
    if (component.kind === 'danmaku') {
      const events = [
        mockAudience('danmaku', '星野', '这是一条带头像的测试弹幕', '#59c8ff', '星'),
        mockAudience('gift', '海盐汽水', '赠送 小电视 × 1', '#ff9c75', '礼'),
        mockAudience('danmaku', '这是一个为了测试截断而故意写得特别特别特别特别长的用户名', '用户名显示上限会在这里生效', '#9a8cff', '长'),
        mockAudience('danmaku', '夜航员', '这是一条为了验证弹幕内容最大显示长度而故意写得特别特别长的测试弹幕，它会继续补充许多文字，确保默认上限和用户手动设置的更长上限都能被清楚地观察到。这段内容还会继续延伸，模拟真实直播里观众一次发来超长说明、连续提问和补充上下文的情况。', '#54d6a1', '航'),
        mockAudience('gift', '舰长观众', '赠送 舰长 × 1，感谢支持', '#f2c14e', '舰'),
      ].filter((event) => acceptsAudience(component, event));
      const delays = [520, 760, 620, 880, 680];
      let index = 0;
      const emitNext = () => {
        const event = events[index % events.length];
        for (const element of elements) {
          const feed = feeds.get(element.dataset.placementId);
          if (feed) renderAudienceInto(feed, event);
        }
        const delay = delays[index % delays.length];
        index += 1;
        scheduleMock(token, delay, emitNext);
      };
      emitNext();
      return;
    }

    if (component.kind === 'scroll-notice') {
      for (const element of elements) {
        const viewport = element.querySelector('.scroll-viewport');
        const track = element.querySelector('.scroll-track');
        if (!viewport || !track) continue;
        restartNotice(
          track,
          viewport,
          component,
          styleById(component.styleId).body,
          '欢迎来到直播间\n今晚八点开始联机挑战\n关注主播，不错过开播通知',
        );
      }
      return;
    }

    if (component.kind === 'fixed-notice') {
      for (const element of elements) {
        const content = element.querySelector('.component-content');
        if (content) content.replaceChildren(textElement('Mock · 这是一条固定公告测试内容', styleById(component.styleId).body));
      }
      return;
    }

    if (component.kind === 'agent-notice') {
      for (const element of elements) {
        const content = element.querySelector('.component-content');
        if (content) renderAgentText(
          content,
          '今晚直播安排：先读弹幕，再一起看看新功能。',
          styleById(component.styleId).body,
          component.typingMs > 0 ? component.typingMs : 42,
          element.dataset.placementId,
        );
      }
      return;
    }

    if (component.kind === 'video-queue') {
      for (const element of elements) {
        const content = element.querySelector('.component-content');
        if (content) renderVideoQueue(element, content, component, styleById(component.styleId), [
          { bvid: 'BV1Ab4y1C7dE', note: '一起看新番预告 · 星野' },
          { bvid: 'BV1Qx411m7Ks', note: '这是一条为了验证省略号而故意写得很长很长很长很长的视频备注' },
          { bvid: 'BV1Zr4y1N7pQ', note: '' },
        ]);
      }
      return;
    }

    if (component.kind === 'image' && !componentImageSource(component)) {
      for (const element of elements) {
        const image = element.querySelector('.component-content img');
        if (image) image.src = mockImageSource();
      }
    }
  }

  function mockPlacement(component) {
    const preset = component.kind === 'danmaku'
      ? { width: 720, height: 320 }
      : component.kind === 'image'
        ? { width: 520, height: 300 }
        : component.kind === 'video-queue'
          ? { width: 600, height: 320 }
          : { width: 820, height: 140 };
    const width = Math.min(preset.width, design.canvas.width);
    const height = Math.min(preset.height, design.canvas.height);
    const z = Math.max(0, ...design.placements.map((placement) => placement.z)) + 1;
    return {
      id: '__editor_mock__',
      componentId: component.id,
      x: (design.canvas.width - width) / 2,
      y: (design.canvas.height - height) / 2,
      width,
      height,
      z,
      visible: true,
      locked: false,
    };
  }

  function mockAudience(eventKind, username, body, color, avatarLabel) {
    return {
      eventKind,
      username,
      body,
      avatarUrl: mockAvatarSource(color, avatarLabel),
      facts: { eventKind },
    };
  }

  function mockAvatarSource(color, label) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="${color}"/><circle cx="48" cy="37" r="18" fill="#fff" fill-opacity=".9"/><path d="M17 91c3-23 15-35 31-35s28 12 31 35" fill="#fff" fill-opacity=".9"/><text x="48" y="88" text-anchor="middle" font-size="15" font-family="sans-serif" fill="#18202e">${label}</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function mockImageSource() {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 300"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#182536"/><stop offset="1" stop-color="#3c6781"/></linearGradient></defs><rect width="520" height="300" fill="url(#g)"/><circle cx="260" cy="122" r="46" fill="#fff" fill-opacity=".14"/><path d="m225 132 23-25 22 20 19-16 31 38h-95z" fill="#fff" fill-opacity=".8"/><text x="260" y="215" text-anchor="middle" font-size="24" font-family="sans-serif" fill="#fff">IMAGE MOCK</text></svg>';
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function scheduleMock(token, delay, action) {
    const timer = setTimeout(() => {
      mockTimers.delete(timer);
      if (token === mockToken) action();
    }, delay);
    mockTimers.add(timer);
  }

  function cancelMockTimers() {
    mockToken += 1;
    for (const timer of mockTimers) clearTimeout(timer);
    mockTimers.clear();
  }

  function appendVertical(feed, item) {
    const previous = new Map(Array.from(feed.element.children, (child) => [child, child.getBoundingClientRect().top]));
    feed.element.appendChild(item);
    const entryDuration = Math.max(100, item.getBoundingClientRect().height / feed.component.speed * 1000);
    item.style.animationDuration = `${entryDuration}ms`;
    while (feed.element.children.length > feed.component.maxItems) feed.element.firstElementChild.remove();
    requestAnimationFrame(() => {
      for (const child of feed.element.children) {
        if (child === item) continue;
        const oldTop = previous.get(child);
        if (oldTop === undefined) continue;
        const delta = oldTop - child.getBoundingClientRect().top;
        if (Math.abs(delta) > .5) {
          child.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], {
            duration: Math.max(100, Math.abs(delta) / feed.component.speed * 1000),
            easing: 'ease-out',
          });
        }
      }
    });
  }

  function launchHorizontal(feed, item) {
    const lineHeight = Math.max(1, feed.laneHeight);
    const laneCount = Math.max(1, Math.floor(feed.element.clientHeight / lineHeight));
    const capacity = feed.component.maxItems * laneCount;
    if (feed.element.children.length >= capacity) return;
    feed.element.appendChild(item);
    let laneState = horizontalLanes.get(feed.key);
    if (!laneState || laneState.ready.length !== laneCount) {
      laneState = { cursor: 0, ready: Array(laneCount).fill(0) };
      horizontalLanes.set(feed.key, laneState);
    }
    const now = performance.now();
    let lane = -1;
    for (let offset = 0; offset < laneCount; offset += 1) {
      const candidate = (laneState.cursor + offset) % laneCount;
      if (laneState.ready[candidate] <= now) { lane = candidate; break; }
    }
    if (lane < 0) lane = laneState.ready.indexOf(Math.min(...laneState.ready));
    const delay = Math.max(0, laneState.ready[lane] - now);
    laneState.cursor = (lane + 1) % laneCount;
    item.style.top = `${lane * lineHeight}px`;
    const distance = feed.element.clientWidth + item.scrollWidth + 20;
    const duration = Math.max(1000, distance / feed.component.speed * 1000);
    const actualSpeed = distance / (duration / 1000);
    laneState.ready[lane] = now + delay + (item.scrollWidth + feed.component.gap) / actualSpeed * 1000;
    item.style.opacity = '0';
    const animation = item.animate(
      [
        { transform: 'translateX(0)', opacity: 1 },
        { transform: `translateX(-${distance}px)`, opacity: 1 },
      ],
      { duration, delay, easing: 'linear' },
    );
    animation.addEventListener('finish', () => item.remove(), { once: true });
  }

  function restartNotice(track, viewport, component, style, text = component.text) {
    const revision = String(Number(track.dataset.animationRevision || 0) + 1);
    track.dataset.animationRevision = revision;
    for (const animation of track.getAnimations()) animation.cancel();
    track.classList.remove('line-carousel');
    track.style.gap = '';
    const lines = String(text ?? '').split(/\r?\n/).filter((line) => line.trim());
    const lineCarousel = lines.length > 1 && component.lineTransitionMs > 0;
    if (lineCarousel) {
      track.classList.add('line-carousel');
      const slides = lines.map((line) => {
        const slide = textElement(line, style);
        slide.classList.add('notice-slide');
        return slide;
      });
      track.replaceChildren(...slides, slides[0].cloneNode(true));
    } else {
      const line = textElement(String(text ?? ''), style);
      line.style.flex = '0 0 auto';
      track.replaceChildren(line);
    }
    requestAnimationFrame(() => {
      if (!track.isConnected || track.dataset.animationRevision !== revision) return;
      if (lineCarousel) animateLineNotice(track, viewport, component, lines.length);
      else animateContinuousNotice(track, viewport, component);
    });
  }

  function animateContinuousNotice(track, viewport, component) {
    const horizontal = component.axis === 'horizontal';
    const contentDistance = horizontal
      ? viewport.clientWidth + track.scrollWidth
      : viewport.clientHeight + track.scrollHeight;
    const distance = contentDistance + component.gap;
    const duration = Math.max(1000, distance / component.speed * 1000);
    const from = horizontal ? 'translate(0,-50%)' : 'translate(-50%,0)';
    const to = horizontal ? `translate(-${distance}px,-50%)` : `translate(-50%,-${distance}px)`;
    track.animate([{ transform: from }, { transform: to }], {
      duration,
      iterations: Infinity,
      easing: 'linear',
    });
  }

  function animateLineNotice(track, viewport, component, lineCount) {
    const horizontal = component.axis === 'horizontal';
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    const gap = Math.max(0, Number(component.gap) || 0);
    const step = (horizontal ? width : height) + gap;
    track.style.gap = `${gap}px`;
    for (const slide of track.children) {
      slide.style.width = `${width}px`;
      slide.style.height = `${height}px`;
    }

    const hold = Math.max(0, Number(component.lineHoldMs) || 0);
    const transition = Math.max(1, Number(component.lineTransitionMs) || 0);
    const cycle = hold + transition;
    const duration = lineCount * cycle;
    const transform = (index) => horizontal
      ? `translateX(-${step * index}px)`
      : `translateY(-${step * index}px)`;
    const keyframes = [{ transform: transform(0), offset: 0 }];
    for (let index = 0; index < lineCount; index += 1) {
      if (hold) keyframes.push({
        transform: transform(index),
        offset: (index * cycle + hold) / duration,
      });
      keyframes.push({
        transform: transform(index + 1),
        offset: ((index + 1) * cycle) / duration,
      });
    }
    track.animate(keyframes, { duration, iterations: Infinity, easing: 'linear' });
  }

  function applyEdgeFade(element, axis, value) {
    const fade = Math.max(0, Number(value) || 0);
    if (!fade) return;
    const direction = axis === 'vertical' ? 'to bottom' : 'to right';
    const mask = `linear-gradient(${direction}, transparent 0, #000 min(${fade}px, 50%), #000 max(calc(100% - ${fade}px), 50%), transparent 100%)`;
    element.style.maskImage = mask;
    element.style.webkitMaskImage = mask;
  }

  function componentImageSource(component) {
    if (component.source === 'upload' && component.assetId) {
      return `/assets/${encodeURIComponent(component.assetId)}`;
    }
    return component.source === 'external' ? component.url || '' : '';
  }

  function applyPanelStyle(element, style) {
    element.style.borderImage = '';
    element.style.background = style.background;
    element.style.borderColor = style.borderColor;
    element.style.borderWidth = `${style.borderWidth}px`;
    element.style.borderStyle = style.borderWidth ? 'solid' : 'none';
    element.style.borderRadius = `${style.radius}px`;
    element.style.padding = `${style.padding}px`;
    if (style.nineSlice && style.nineSlice.assetId) {
      const nine = style.nineSlice;
      const slice = nine.slice || nine;
      const width = nine.width || slice;
      element.style.borderStyle = 'solid';
      element.style.borderWidth = `${width.top}px ${width.right}px ${width.bottom}px ${width.left}px`;
      element.style.borderColor = 'transparent';
      element.style.borderImageSource = `url('/assets/${encodeURIComponent(nine.assetId)}')`;
      element.style.borderImageSlice = `${slice.top} ${slice.right} ${slice.bottom} ${slice.left}${nine.fill ? ' fill' : ''}`;
      element.style.borderImageWidth = `${width.top}px ${width.right}px ${width.bottom}px ${width.left}px`;
      element.style.borderImageRepeat = nine.repeat || 'stretch';
    }
  }

  function textElement(text, style) {
    const element = document.createElement('span');
    element.className = 'overlay-text';
    element.textContent = text;
    applyTextStyle(element, style);
    return element;
  }

  function applyTextStyle(element, style) {
    element.style.fontFamily = style.fontFamily;
    element.style.fontSize = `${style.fontSize}px`;
    element.style.fontWeight = String(style.fontWeight);
    element.style.color = style.color;
    element.style.webkitTextStroke = `${style.strokeWidth}px ${style.strokeColor}`;
    element.style.paintOrder = 'stroke fill';
  }

  function styleById(id) {
    return design.styles.find((item) => item.id === id)
      || builtinStyles.find((item) => item.id === id)
      || builtinStyles[0]
      || {
        background: '#00000099', borderColor: '#00000000', borderWidth: 0, radius: 0, padding: 8,
        username: defaultText(), body: defaultText(),
      };
  }

  function defaultText() {
    return {
      fontFamily: 'Microsoft YaHei, sans-serif', fontSize: 30, fontWeight: 500,
      color: '#ffffff', strokeColor: '#000000', strokeWidth: 0,
    };
  }

  function fitStage() {
    if (!design) return;
    const scale = Math.min(innerWidth / design.canvas.width, innerHeight / design.canvas.height);
    const left = (innerWidth - design.canvas.width * scale) / 2;
    const top = (innerHeight - design.canvas.height * scale) / 2;
    stage.style.transform = `translate(${left}px,${top}px) scale(${scale})`;
  }
})();
