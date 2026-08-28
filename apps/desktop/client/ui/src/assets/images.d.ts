// Vite 资产导入（logo 等图片）——ui 包 tsconfig types 只含 node，无 vite/client，
// 此处补最小声明（electron-vite renderer 构建走标准 vite 资产管线，无需完整 vite/client）。
declare module '*.png' {
  const src: string;
  export default src;
}
