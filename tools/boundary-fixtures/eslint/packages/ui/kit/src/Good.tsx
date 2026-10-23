// 允许：用 token 变量；看起来像颜色但不是的字符串
export const styles = { border: '1px solid var(--line)', color: 'var(--ink)' };
export const anchor = '#section-2';
export const entity = '&#160;';
export const Badge = () => <span style={{ background: 'var(--attention)' }}>Needs you</span>;
