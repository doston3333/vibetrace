import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { App } from './App.js';

describe('App', () => {
  it('opens the 1,000-event static trace and exposes an event inspector', () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain('<h1>VibeTrace</h1>');
    expect(markup).toContain('1,000</strong> captured fixture events');
    expect(markup).toContain('capture mode: <strong>standard</strong>');
    expect(markup).toContain('id="event-inspector">Event inspector</h2>');
    expect(markup).toContain('Event 1: <strong>file.read</strong>');
    expect(markup).toContain('&lt;synthetic-trace-content&gt;');
    expect(markup).not.toContain('<synthetic-trace-content>');
    expect(markup).toContain('This sample is not live capture.');
  });
});
