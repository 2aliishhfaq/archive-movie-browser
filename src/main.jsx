import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';

document.title = 'Archive / Movies — Films worth finding';
const canonical = 'https://reelbox-red.vercel.app' + location.pathname;
let canonicalTag = document.querySelector('link[rel="canonical"]');
if (!canonicalTag) { canonicalTag = document.createElement('link'); canonicalTag.rel = 'canonical'; document.head.appendChild(canonicalTag); }
canonicalTag.href = canonical;

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>
);
