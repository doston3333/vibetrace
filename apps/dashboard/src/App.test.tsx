import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { App } from './App.js';

describe('App', () => {
  it('renders the VibeTrace foundation placeholder', () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain('<h1>VibeTrace</h1>');
    expect(markup).toContain('Foundation status: dashboard placeholder.');
  });
});
