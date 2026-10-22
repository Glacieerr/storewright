import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { opaqueLabelId } from '@storewright/domain';
import { humanLabelId, labelBadges, qrPixels, slotClock, slotLabelSvg, slotLabelZpl, toteLabelSvg, toteLabelZpl, zplField, type ToteLabelData } from './index';

const base: ToteLabelData = {
  labelId: opaqueLabelId('O-123-T1', 1),
  version: 1,
  firstName: 'Alexandria',
  lastName: 'Konstantinopoulos',
  nameMaxLength: 16,
  orderShortCode: 'C1Q5',
  index: 1,
  count: 2,
  slotStart: Date.UTC(2026, 9, 20, 16, 0),
  timeZone: 'UTC',
  type: 'DELIVERY',
  tempZone: 'FROZEN',
  ageRestricted: true,
  chemical: false,
};

describe('标签', () => {
  it('二维码可以解码，内容只有不透明标签 ID', () => {
    for (const text of [base.labelId, opaqueLabelId('X', 3), 'AMB-03-02-16']) {
      const img = qrPixels(text);
      const res = jsQR(img.data, img.width, img.height);
      expect(res?.data).toBe(text);
    }
    expect(base.labelId).toMatch(/^SW1:[A-Z2-9]{9}$/);
  });

  it('取货框标签：姓名超长时缩写、时段、框序号、温区与特殊标记；SVG 里的二维码不含姓名', () => {
    const svg = toteLabelSvg(base);
    expect(svg).toContain('Alexandria K.');
    expect(svg).toContain('16:00');
    expect(svg).toContain('TOTE 1/2');
    expect(svg).toContain('FROZEN');
    expect(svg).toContain('21+ ID CHECK');
    expect(svg).toContain(humanLabelId(base.labelId));
    expect(slotClock(base.slotStart, 'UTC')).toBe('16:00');
    expect(labelBadges({ ageRestricted: false, chemical: true, tempZone: 'HOT' })).toEqual(['CHEMICAL', 'HOT']);
  });

  it('ZPL：以 ^XA 开始、^XZ 结束，含二维码与各字段，特殊字符被转义', () => {
    const zpl = toteLabelZpl({ ...base, firstName: 'Jo^hn', lastName: 'Smith_Jr', nameMaxLength: 30 });
    const lines = zpl.split('\n');
    expect(lines[0]).toBe('^XA');
    expect(lines.at(-1)).toBe('^XZ');
    expect(zpl).toContain(`^BQN,2,6^FDMA,${base.labelId}^FS`);
    expect(zpl).toContain('TOTE 1/2');
    expect(zpl).toContain('^FR^FDFROZEN');
    expect(zpl).toContain('Jo_5Ehn Smith_5FJr');
    expect(zplField('a~b')).toBe('^FH_^FDa_7Eb^FS');
  });

  it('暂存格位标签', () => {
    expect(slotLabelSvg('AMB-03-02-16', 'AMBIENT')).toContain('AMB-03-02-16');
    expect(slotLabelZpl('CHL-01-01-01', 'CHILLED')).toContain('^FDMA,CHL-01-01-01^FS');
  });
});

describe('后仓箱标签与库位标签', () => {
  it('Digital Link 二维码可解码；UPC-A 模块正确；ZPL 含二维码和条码', async () => {
    const { caseLabelSvg, caseLabelZpl, upcModules, upcFromGtin, locationLabelSvg } = await import('./index');
    const { caseDigitalLink, parseDigitalLink } = await import('@storewright/domain');
    const data = { caseId: 'C-261018-000482', gtin: '00012345678905', name: 'Long Grain Rice 2 lb', packQty: 12, receivedAt: Date.UTC(2026, 9, 18) };
    const link = caseDigitalLink(data.gtin, data.caseId);
    const img = qrPixels(link);
    expect(jsQR(img.data, img.width, img.height)?.data).toBe(link);
    expect(parseDigitalLink(link)?.caseId).toBe(data.caseId);
    expect(upcFromGtin(data.gtin)).toBe('012345678905');
    const m = upcModules('012345678905');
    expect(m).toHaveLength(95);
    expect(m.startsWith('101') && m.endsWith('101') && m.slice(45, 50) === '01010').toBe(true);
    const svg = caseLabelSvg(data);
    expect(svg).toContain('C-261018-000482');
    expect(svg).toContain('12 EA');
    expect(svg).toContain('2026-10-18');
    const zpl = caseLabelZpl(data);
    expect(zpl).toContain(`^FDMA,${link}^FS`);
    expect(zpl).toContain('^BUN,170,Y,N,Y^FD01234567890^FS');
    expect(locationLabelSvg('BR-1-03-2A', 'BACKROOM · DRY')).toContain('BR-1-03-2A');
  });
});
