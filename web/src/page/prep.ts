import { fileUrl } from '@/files/kinds.ts';

/**
 * What the page frame gets: the file's HTML with nothing that runs (the frame's sandbox already stops scripts; a
 * script-src 'none' policy and the removal of scripts, handlers and `javascript:` links say it twice), and its
 * relative resources (images, stylesheets, an SVG's `<image>` / `<use>`) pointed at the project's files beside it.
 * `scripts`: the page had any, so it may look different than in a browser.
 */
export function preparePage(html: string, baseDir: string | undefined, src: string): { doc: string; scripts: boolean } {
  const d = new DOMParser().parseFromString(html, 'text/html');
  let scripts = false;
  for (const e of d.querySelectorAll('script')) {
    scripts = true;
    e.remove();
  }
  // the frame's own address must not change (a <base> would send every relative link elsewhere), nor reload it
  for (const e of d.querySelectorAll('base, meta[http-equiv]')) e.remove();
  for (const e of d.querySelectorAll('*')) {
    for (const a of [...e.attributes]) {
      const name = a.name.toLowerCase();
      if (name.startsWith('on')) {
        scripts = true;
        e.removeAttribute(a.name);
      } else if ((name === 'href' || name === 'src' || name === 'xlink:href' || name === 'action') && /^\s*javascript:/i.test(a.value)) {
        e.removeAttribute(a.name);
      }
    }
  }
  const relative = (u: string | null): u is string => !!u && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(u.trim());
  const point = (e: Element, attr: string) => {
    const v = e.getAttribute(attr);
    if (relative(v)) e.setAttribute(attr, fileUrl(v.trim(), baseDir, src));
  };
  for (const e of d.querySelectorAll('img, source, video, audio, track, input[type=image]')) point(e, 'src');
  for (const e of d.querySelectorAll('video')) point(e, 'poster');
  for (const e of d.querySelectorAll('link[rel~=stylesheet], link[rel~=icon]')) point(e, 'href');
  for (const e of d.querySelectorAll('image, use, feImage')) {
    point(e, 'href');
    point(e, 'xlink:href');
  }
  const head = d.head;
  const csp = d.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
  head.prepend(csp);
  // the frame grows to the page's height (HtmlBody), so the pane scrolls it, not the frame
  const style = d.createElement('style');
  style.textContent = 'html{overflow-y:hidden!important}';
  head.append(style);
  return { doc: `${d.doctype ? '<!doctype html>' : ''}${d.documentElement.outerHTML}`, scripts };
}
