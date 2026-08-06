import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('atomic dist build', () => {
  it('builds in staging and atomically exchanges the complete live dist tree', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const source = readFileSync(join(process.cwd(), 'scripts/build-atomic.mjs'), 'utf8');
    expect(pkg.scripts.build).toBe('node scripts/build-atomic.mjs');
    expect(source).toContain('stagingDist');
    expect(source).toContain('RENAME_EXCHANGE');
    expect(source).toContain('exchangeDirectoriesLinux(stagingDist, liveDist)');
    expect(source).not.toContain("rmSync(liveDist");
  });

  it('routes the dashboard bundle into the same staging tree', () => {
    const source = readFileSync(join(process.cwd(), 'scripts/build-dashboard.mjs'), 'utf8');
    expect(source).toContain("process.env.BOTMUX_DIST_DIR || 'dist'");
  });
});
