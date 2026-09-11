(() => {
    const cameraMode = new URLSearchParams(window.location.search).has('camera');
    const canvas = document.getElementById('live2d');
    let reported = false;

    function notify(type, detail) {
        if (reported && type === 'live2d-error') return;
        if (type === 'live2d-error') reported = true;
        window.parent.postMessage({ type, detail }, window.location.origin);
    }

    function resize() {
        if (!canvas) return;
        const bounds = canvas.getBoundingClientRect();
        window.adjustSize(bounds.width, bounds.height);
    }

    function receiveEvent(event) {
        try {
            const payload = JSON.parse(event.data);
            if (payload?.type === 'message' && typeof payload.message === 'string') {
                window.receiveMsg(payload.message, payload.duration);
            }
        } catch {
            // Malformed messages are ignored; EventSource automatically reconnects.
        }
    }

    window.addEventListener('live2d-ready', () => notify('live2d-ready', { modelName: window.model_name }));
    window.addEventListener('live2d-error', (event) => notify('live2d-error', { message: String(event.detail || 'Renderer failed') }));
    window.addEventListener('error', () => notify('live2d-error', { message: 'Renderer asset failed to load' }), { once: true });
    window.addEventListener('unhandledrejection', () => notify('live2d-error', { message: 'Renderer asset failed to load' }), { once: true });
    window.addEventListener('resize', resize, { passive: true });
    window.addEventListener('beforeunload', () => {
        window.removeEventListener('resize', resize);
        document.live2d_release?.();
    }, { once: true });

    if (cameraMode) document.documentElement.classList.add('camera-mode');
    if (!canvas || !(canvas.getContext('webgl2') || canvas.getContext('webgl'))) {
        notify('live2d-error', { message: 'WebGL is unavailable' });
        return;
    }
    const events = new EventSource(new URL('events', window.location.href));
    events.onmessage = receiveEvent;
    window.addEventListener('beforeunload', () => events.close(), { once: true });
    resize();
})();
