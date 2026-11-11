import './style.css';
import { mount } from './ui/app.js';

const root = document.querySelector('#app');
mount(root);
root.removeAttribute('aria-busy');
