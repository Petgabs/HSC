if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .then(registration => registration.update())
      .catch(error => console.warn('[School Cloud] Offline support is unavailable:', error));
  }, { once: true });
}
