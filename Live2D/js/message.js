(() => {
    const MAX_CAPTION_LENGTH = 1_000;
    const DEFAULT_DURATION = 2_000;
    let hideTimer;

    const caption = document.querySelector('.message');

    function boundedDuration(value) {
        const duration = Number(value);
        return Number.isFinite(duration) ? Math.min(60_000, Math.max(100, duration)) : DEFAULT_DURATION;
    }

    function showMessage(value, duration = DEFAULT_DURATION) {
        const element = caption;
        if (!element) return;
        const text = Array.isArray(value) ? value[Math.floor(Math.random() * value.length)] : value;
        element.textContent = String(text ?? '').slice(0, MAX_CAPTION_LENGTH);
        element.classList.add('is-visible');
        window.clearTimeout(hideTimer);
        hideTimer = window.setTimeout(() => element.classList.remove('is-visible'), boundedDuration(duration));
    }

    window.receiveMsg = showMessage;
    window.adjustSize = (width, height) => {
        const canvas = document.getElementById('live2d');
        if (!canvas) return;
        const cssWidth = Math.max(1, Number(width) || window.innerWidth);
        const cssHeight = Math.max(1, Number(height) || window.innerHeight);
        const scale = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(cssWidth * scale);
        canvas.height = Math.round(cssHeight * scale);
        window.live2dResize?.();
    };

    document.touchHeadHandler = () => showMessage('嗯嗯~~~');
    document.touchBodyHandler = () => showMessage('不要动手动脚的！');
})();
