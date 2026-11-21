/**
 * Markdown from any repo branch is rendered, so it is hostile input: no <style> (global CSS), no form controls, and no
 * data-* attributes at all (content data-pane / data-file-path / data-lightbox would collide with app hooks; markRefs and
 * hljs add their own data-* after sanitizing).
 */
export const HARDEN = { FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea'], ALLOW_DATA_ATTR: false };
