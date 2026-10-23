import { describe, expect, it } from 'vitest';
import {
  relaxSameSite,
  relaxSetCookies,
  stripFrameAncestors,
  stripFrameBlockingHeaders,
} from '../../src/main/browser/headers.ts';

describe('stripFrameAncestors', () => {
  it('removes only the frame-ancestors directive', () => {
    expect(stripFrameAncestors("default-src 'self'; frame-ancestors 'none'; script-src 'self'")).toBe(
      "default-src 'self'; script-src 'self'",
    );
  });

  it('is case-insensitive and tolerates extra whitespace', () => {
    expect(stripFrameAncestors("  FRAME-ANCESTORS   'self' ;img-src *")).toBe('img-src *');
  });

  it('returns null when nothing is left', () => {
    expect(stripFrameAncestors("frame-ancestors 'none'")).toBeNull();
    expect(stripFrameAncestors("frame-ancestors 'none';")).toBeNull();
  });

  it('handles several comma-joined policies', () => {
    expect(stripFrameAncestors("frame-ancestors 'none', default-src 'self'; frame-ancestors https://a.test")).toBe(
      "default-src 'self'",
    );
  });

  it('leaves policies without frame-ancestors byte-for-byte unchanged', () => {
    const policy = "default-src 'self';script-src  'unsafe-inline'";
    expect(stripFrameAncestors(policy)).toBe(policy);
  });

  it('does not confuse similarly named directives', () => {
    expect(stripFrameAncestors("frame-src 'self'; frame-ancestors-x 1")).toBe("frame-src 'self'; frame-ancestors-x 1");
  });
});

describe('stripFrameBlockingHeaders', () => {
  it('drops X-Frame-Options in any casing', () => {
    expect(stripFrameBlockingHeaders({ 'X-Frame-Options': ['DENY'], 'content-type': ['text/html'] })).toEqual({
      'content-type': ['text/html'],
    });
    expect(stripFrameBlockingHeaders({ 'x-frame-options': 'SAMEORIGIN' })).toEqual({});
  });

  it('rewrites CSP and keeps the other directives', () => {
    expect(
      stripFrameBlockingHeaders({ 'Content-Security-Policy': ["default-src 'self'; frame-ancestors 'none'"] }),
    ).toEqual({ 'Content-Security-Policy': ["default-src 'self'"] });
  });

  it('drops a CSP header that only had frame-ancestors', () => {
    expect(stripFrameBlockingHeaders({ 'content-security-policy': ["frame-ancestors 'none'"], a: ['1'] })).toEqual({
      a: ['1'],
    });
  });

  it('returns null when nothing needs changing', () => {
    expect(stripFrameBlockingHeaders({ 'content-security-policy': ["default-src 'self'"], a: ['1'] })).toBeNull();
    expect(stripFrameBlockingHeaders({})).toBeNull();
  });

  it('leaves report-only policies alone (they never block)', () => {
    expect(
      stripFrameBlockingHeaders({ 'content-security-policy-report-only': ["frame-ancestors 'none'"] }),
    ).toBeNull();
  });

  it('does not mutate its input', () => {
    const input = { 'x-frame-options': ['DENY'] };
    stripFrameBlockingHeaders(input);
    expect(input).toEqual({ 'x-frame-options': ['DENY'] });
  });
});

describe('relaxSameSite', () => {
  it('replaces SameSite=Lax/Strict with None; Secure', () => {
    expect(relaxSameSite('sid=abc; Path=/; HttpOnly; SameSite=Lax')).toBe('sid=abc; Path=/; HttpOnly; SameSite=None; Secure');
    expect(relaxSameSite('sid=abc; samesite=strict; secure')).toBe('sid=abc; SameSite=None; Secure');
  });

  it('adds None; Secure to cookies without SameSite (Chromium treats them as Lax)', () => {
    expect(relaxSameSite('sid=abc')).toBe('sid=abc; SameSite=None; Secure');
  });

  it('keeps Expires dates (they contain commas) and the cookie value as-is', () => {
    expect(relaxSameSite('a=b=c; Expires=Wed, 21 Oct 2026 07:28:00 GMT')).toBe(
      'a=b=c; Expires=Wed, 21 Oct 2026 07:28:00 GMT; SameSite=None; Secure',
    );
  });
});

describe('relaxSetCookies', () => {
  it('rewrites every Set-Cookie value', () => {
    expect(relaxSetCookies({ 'Set-Cookie': ['a=1; SameSite=Lax', 'b=2'], x: ['y'] })).toEqual({
      'Set-Cookie': ['a=1; SameSite=None; Secure', 'b=2; SameSite=None; Secure'],
      x: ['y'],
    });
  });

  it('returns null without Set-Cookie', () => {
    expect(relaxSetCookies({ 'content-type': ['text/html'] })).toBeNull();
  });
});
