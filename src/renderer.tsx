import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

if (navigator.userAgent.includes('Macintosh')) document.documentElement.classList.add('platform-darwin');

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
