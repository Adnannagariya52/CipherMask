import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import App from './App.tsx';
import './styles/index.css';
import { registerCipherMaskServiceWorker } from './state/offline.ts';

if (import.meta.env.PROD) {
  registerCipherMaskServiceWorker();
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
