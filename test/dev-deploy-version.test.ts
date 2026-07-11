import { describe, expect, it } from 'vitest';
import { bumpPatchVersion, parseDevVersion, readVersionPayload } from '../scripts/lib/dev-version.mjs';

describe('dev deploy version', () => {
  it('increments only the patch component', () => {
    expect(bumpPatchVersion('0.0.0')).toBe('0.0.1');
    expect(bumpPatchVersion('2.7.19')).toBe('2.7.20');
  });

  it('normalizes a valid tracked payload', () => {
    expect(readVersionPayload('{"version":"3.4.5"}')).toEqual({ version: '3.4.5' });
  });

  it('rejects ambiguous or prerelease versions', () => {
    expect(() => parseDevVersion('v1.2.3')).toThrow(/无效 dev version/);
    expect(() => bumpPatchVersion('1.2.3-beta.1')).toThrow(/无效 dev version/);
  });
});
