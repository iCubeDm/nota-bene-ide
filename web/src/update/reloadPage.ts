/** Reloads the page (its own module, so a test can stand in for it: jsdom's location cannot be stubbed). */
export const reloadPage = (): void => window.location.reload();
