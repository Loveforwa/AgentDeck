// Vite 的 ?raw：把 CSS 文件当字符串读进来（测试里检查 -webkit-app-region 这类 jsdom 算不出来的规则）
declare module '*.css?raw' {
  const css: string;
  export default css;
}
