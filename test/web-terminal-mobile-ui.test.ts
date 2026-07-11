import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('web terminal mobile UI source guards', () => {
  const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

  it('keeps touch devices on the real device viewport instead of scaling a fixed 1100px page', () => {
    expect(source).toContain('<meta id="vp" name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">');
    expect(source).not.toContain("content='width=1100,viewport-fit=cover'");
  });

  it('defaults touch terminals to 400% font size and exposes persistent font controls', () => {
    expect(source).toContain('function _defaultFontSize(){return isTouch?56:14}');
    expect(source).toContain("FONT_KEY='botmux.webTerminal.fontSize'");
    expect(source).toContain('id="font-smaller"');
    expect(source).toContain('id="font-larger"');
    expect(source).toContain('FONT_MAX=72');
    expect(source).toContain("term.options.fontSize=currentFontSize");
  });
});
