const params = new URLSearchParams(window.location.search);
    const event = params.get('event');
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'docusign-return', event }, window.location.origin);
    }
