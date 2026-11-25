import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { App } from './App.tsx';
import { loginFromFragment } from './core/net/auth.ts';
import { isHome } from './core/net/home.ts';
import { Home } from './core/shell/Home.tsx';
import { loadRemotePage } from './core/net/local.ts';
import { agentBase, defaultSocketUrl } from './core/net/socket.ts';
import { makeStore } from './core/store/store.ts';
import { PLUGINS } from './plugins.ts';
import './core/shell/theme.ts';
import './fonts.css';
import './theme.css';

// the window is opened on `/#t=<token>`: trade it for the login cookie before the first request and the socket need it
// the top of a server is its home page, its agents are under /a/<id>/ (issue 639); then whether this is another computer's
// window shown through this one (issue 297): the UI hides what is not there
void loginFromFragment().then(() => isHome()).then(async (home) => {
  await loadRemotePage();
  const store = makeStore({ url: defaultSocketUrl(location), base: agentBase(location), plugins: PLUGINS, ...(home ? { socket: false as const } : {}) });
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Provider store={store}>
        {home ? <Home /> : <App />}
      </Provider>
    </StrictMode>,
  );
});
