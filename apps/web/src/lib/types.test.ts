import { describe, expect, it } from 'vitest';
import { platformLabel, platforms } from './types';

describe('platform mapping', () => {
  it('keeps API enum values while exposing the product labels', () => {
    expect(platforms).toEqual(['windows', 'windows-x86', 'linux', 'android', 'macos']);
    expect(platformLabel['windows-x86']).toBe('Windows x86');
    expect(platformLabel.macos).toBe('macOS');
  });
});
