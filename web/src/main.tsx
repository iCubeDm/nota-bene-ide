import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { App } from './App.tsx';
import { fragmentSession, loginFromFragment } from './core/net/auth.ts';
import { loadRemotePage } from './core/net/local.ts';
import { startLanding } from './plugins/projects/landing.ts';
import { enterFailure } from './plugins/projects/api.ts';
import { agentBase, defaultSocketUrl } from './core/net/socket.ts';
import { makeStore } from './core/store/store.ts';
import { PLUGINS } from './plugins.ts';
import './core/shell/theme.ts';
import './fonts.css';
import './theme.css';

// the window is opened on `/#t=<token>`: trade it for the login cookie before the first request and the socket need it
// a hand-off from the project switcher may also name the session to open (`&s=`): read it before the login drops the hash
const landing = fragmentSession(location.hash);
// then whether this is another computer's window shown through this one (issue 297): the UI hides what is not there
void loginFromFragment().then(() => loadRemotePage()).then(() => {
  const store = makeStore({ url: defaultSocketUrl(location), base: agentBase(location), plugins: PLUGINS });
  if (landing) startLanding(store, landing);
  enterFailure();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Provider store={store}>
        <App />
      </Provider>
    </StrictMode>,
  );
});
