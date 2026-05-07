import { describe, it, expect } from 'vitest';
import { parseStringStyle, stringifyStyle, camelToKebab } from '../src/server/render-core';

describe('parseStringStyle', () => {
    it('parses a single property', () => {
        expect(parseStringStyle('color: red')).toEqual({ color: 'red' });
    });

    it('parses multiple properties', () => {
        expect(parseStringStyle('color: red; font-size: 14px')).toEqual({
            color: 'red',
            'font-size': '14px',
        });
    });

    it('handles trailing semicolons', () => {
        expect(parseStringStyle('color: red;')).toEqual({ color: 'red' });
    });

    it('handles leading/trailing whitespace on properties', () => {
        expect(parseStringStyle('  color : red ;  font-size : 14px  ')).toEqual({
            color: 'red',
            'font-size': '14px',
        });
    });

    it('strips CSS comments', () => {
        expect(parseStringStyle('color: red; /* this is hidden */ font-size: 14px')).toEqual({
            color: 'red',
            'font-size': '14px',
        });
    });

    it('strips multi-line CSS comments', () => {
        expect(parseStringStyle('color: red; /* multi\nline\ncomment */ font-size: 14px')).toEqual({
            color: 'red',
            'font-size': '14px',
        });
    });

    it('preserves semicolons inside parentheses (gradients)', () => {
        expect(parseStringStyle('background: linear-gradient(to right, red, blue); color: white')).toEqual({
            background: 'linear-gradient(to right, red, blue)',
            color: 'white',
        });
    });

    it('handles colons in values (URLs)', () => {
        expect(parseStringStyle('background: url(https://example.com/img.png)')).toEqual({
            background: 'url(https://example.com/img.png)',
        });
    });

    it('handles data URIs with multiple colons', () => {
        expect(parseStringStyle('background: url(data:image/png;base64,abc123)')).toEqual({
            background: 'url(data:image/png;base64,abc123)',
        });
    });

    it('returns empty object for empty string', () => {
        expect(parseStringStyle('')).toEqual({});
    });

    it('returns empty object for whitespace-only string', () => {
        expect(parseStringStyle('   ')).toEqual({});
    });

    it('returns empty object for semicolons-only string', () => {
        expect(parseStringStyle(';;;')).toEqual({});
    });

    it('ignores declarations with no value', () => {
        expect(parseStringStyle('color')).toEqual({});
    });

    it('handles CSS custom properties (variables)', () => {
        expect(parseStringStyle('--my-var: 10px; color: var(--my-var)')).toEqual({
            '--my-var': '10px',
            color: 'var(--my-var)',
        });
    });

    it('handles complex multi-property styles', () => {
        const css = 'margin: 0 auto; padding: 10px 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1)';
        const result = parseStringStyle(css);
        expect(result['margin']).toBe('0 auto');
        expect(result['padding']).toBe('10px 20px');
        expect(result['background']).toBe('linear-gradient(135deg, #667eea 0%, #764ba2 100%)');
        expect(result['border-radius']).toBe('8px');
        expect(result['box-shadow']).toBe('0 2px 4px rgba(0,0,0,0.1)');
    });
});

describe('stringifyStyle', () => {
    it('serializes a single property', () => {
        expect(stringifyStyle({ color: 'red' })).toBe('color:red;');
    });

    it('serializes multiple properties with camelCase→kebab conversion', () => {
        const result = stringifyStyle({ fontSize: '14px', backgroundColor: 'blue' });
        expect(result).toBe('font-size:14px;background-color:blue;');
    });

    it('skips null values', () => {
        expect(stringifyStyle({ color: 'red', fontSize: null })).toBe('color:red;');
    });

    it('skips undefined values', () => {
        expect(stringifyStyle({ color: 'red', fontSize: undefined })).toBe('color:red;');
    });

    it('skips empty string values', () => {
        expect(stringifyStyle({ color: 'red', fontSize: '' })).toBe('color:red;');
    });

    it('returns empty string for empty object', () => {
        expect(stringifyStyle({})).toBe('');
    });

    it('preserves CSS custom properties', () => {
        expect(stringifyStyle({ '--my-var': '10px' })).toBe('--my-var:10px;');
    });

    it('handles numeric values', () => {
        expect(stringifyStyle({ opacity: 0.5, zIndex: 10 })).toBe('opacity:0.5;z-index:10;');
    });
});

describe('camelToKebab', () => {
    it('converts camelCase to kebab-case', () => {
        expect(camelToKebab('fontSize')).toBe('font-size');
        expect(camelToKebab('backgroundColor')).toBe('background-color');
        expect(camelToKebab('borderTopLeftRadius')).toBe('border-top-left-radius');
    });

    it('preserves CSS custom properties (--prefix)', () => {
        expect(camelToKebab('--my-var')).toBe('--my-var');
    });

    it('preserves already-kebab strings', () => {
        expect(camelToKebab('color')).toBe('color');
    });
});
