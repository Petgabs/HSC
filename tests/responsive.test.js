import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { INTERFACE_BREAKPOINTS, interfaceModeForViewport } from '../assets/js/lib/responsive.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

describe('responsive device interfaces', () => {
  it('maps phone, tablet and computer widths to viewport-based interface modes', () => {
    expect(INTERFACE_BREAKPOINTS).toEqual({ phoneMax: 640, tabletMax: 1280 });
    expect(interfaceModeForViewport(390)).toBe('phone');
    expect(interfaceModeForViewport(640)).toBe('tablet');
    expect(interfaceModeForViewport(1024)).toBe('tablet');
    expect(interfaceModeForViewport(1279)).toBe('tablet');
    expect(interfaceModeForViewport(1280)).toBe('desktop');
    expect(interfaceModeForViewport(0)).toBe('desktop');
    expect(interfaceModeForViewport(Number.NaN)).toBe('desktop');
  });

  it('recalculates on orientation or resize and provides touch-friendly compact navigation', async () => {
    const [html, app, css, worker] = await Promise.all([
      read('../index.html'), read('../assets/js/app.js'), read('../assets/css/tailwind.src.css'), read('../sw.js')
    ]);
    expect(html).toContain('viewport-fit=cover');
    expect(html).toContain(':data-interface-mode="interfaceMode"');
    expect(html).toContain('compact-header-menu');
    expect(html).toContain('library-filter-controls');
    expect(app).toContain('interfaceModeForViewport(viewportWidth)');
    expect(app).toContain("addEventListener('orientationchange', refreshInterfaceMode");
    expect(app).toContain("addEventListener('resize', refreshInterfaceMode");
    expect(css).toContain('@media (max-width: 639px)');
    expect(css).toContain('@media (min-width: 640px) and (max-width: 1023px)');
    expect(css).toContain('@media (min-width: 1280px)');
    expect(css).toContain('(pointer: coarse)');
    expect(css).toContain('safe-area-inset-bottom');
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(worker).toContain("'./assets/js/lib/responsive.js'");
  });
});
