// 违规：界面里写死颜色。每一处都应该被 ESLint 拦住。
export const styles = {
  border: '1px solid #ddd',
  color: '#1A1A1A',
  shadow: 'rgba(0, 0, 0, 0.2)',
  fill: 'hsl(30 10% 90%)',
};
export const accent = `0 0 0 2px rgb(255 120 0)`;
export const Badge = () => <span style={{ background: '#ff7a00' }}>Needs you</span>;
export const modern = 'oklch(70% 0.1 50)';
