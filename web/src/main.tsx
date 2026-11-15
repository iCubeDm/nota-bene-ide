import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { App } from './App.tsx';
import { fragmentSession, loginFromFragment } from './net/auth.ts';
import { startLanding } from './projects/landing.ts';
import { defaultSocketUrl } from './net/socket.ts';
import { makeStore } from './store/store.ts';
import './shell/theme.ts';
import './fonts.css';
import './theme.css';

// the window is opened on `/#t=<token>`: trade it for the login cookie before the first request and the socket need it
// a hand-off from the project switcher may also name the session to open (`&s=`): read it before the login drops the hash
const landing = fragmentSession(location.hash);
void loginFromFragment().then(() => {
  const store = makeStore({ url: defaultSocketUrl(location) });
  if (landing) startLanding(store, landing);
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Provider store={store}>
        <App />
      </Provider>
    </StrictMode>,
  );
});
