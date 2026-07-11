import { describe, expect, it } from 'vitest';

import {
  renderLinkedSessionText,
  renderSessionLiveListHtml,
} from '../src/dashboard/web/sessions.js';

describe('dashboard session live snippets', () => {
  it('turns URLs into direct links while preserving trailing punctuation', () => {
    const html = renderLinkedSessionText('see http://example.com/path?q=1, then continue');
    expect(html).toContain('<a href="http://example.com/path?q=1"');
    expect(html).toContain('>http://example.com/path?q=1</a>,');
  });

  it('highlights query matches and user follow-up snippets', () => {
    const rendered = renderSessionLiveListHtml({
      sessionId: 's1',
      liveEvents: [
        { id: 'u1', kind: 'user', content: '追加反馈 search target', at: 100 },
        { id: 'p1', kind: 'assistant_progress', content: 'search target acknowledged', at: 200 },
      ],
    }, 'target', 1);

    expect(rendered.matchCount).toBe(2);
    expect(rendered.activeEventId).toBe('p1');
    expect(rendered.html).toContain('session-live-event from-user is-match');
    expect(rendered.html).toContain('<mark>target</mark>');
    expect(rendered.html).toContain('active-match');
  });
});
