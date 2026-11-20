import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { App } from './App.tsx';
import { fragmentSession, loginFromFragment } from './net/auth.ts';
import { loadRemotePage } from './net/local.ts';
import { startLanding } from './projects/landing.ts';
import { enterFailure } from './projects/api.ts';
import { defaultSocketUrl } from './net/socket.ts';
import { makeStore } from './store/store.ts';
import './shell/theme.ts';
import './fonts.css';
import './theme.css';

// the window is opened on `/#t=<token>`: trade it for the login cookie before the first request and the socket need it
// a hand-off from the project switcher may also name the session to open (`&s=`): read it before the login drops the hash
const landing = fragmentSession(location.hash);
// then whether this is another computer's window shown through this one (issue 297): the UI hides what is not there
void loginFromFragment().then(() => loadRemotePage()).then(() => {
  const store = makeStore({ url: defaultSocketUrl(location) });
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
