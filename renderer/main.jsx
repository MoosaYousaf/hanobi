import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { start } from './store.js';
import './styles.css';

start();
createRoot(document.getElementById('root')).render(<App />);
