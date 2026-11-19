import React from 'react';
import { useGravityBox } from './hooks/useGravityBox';
import { TrayPanel } from './views/TrayPanel';
import { MainConsole } from './views/MainConsole';

export const App: React.FC = () => {
  const store = useGravityBox();
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view') === 'tray' ? 'tray' : 'main';

  return (
    <>
      {view === 'tray' ? <TrayPanel store={store} /> : <MainConsole store={store} />}
      {store.toast && (
        <div
          className={`toast ${store.toast.error ? 'error' : ''}`}
          role="status"
          onClick={store.clearToast}
        >
          <span>{store.toast.message}</span>
        </div>
      )}
    </>
  );
};

export default App;
